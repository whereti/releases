/**
 * releases.whereti.com
 *
 * The update endpoint whereti asks, at most once a day:
 *
 *   GET /{target}/{arch}/{installed_version}
 *
 * Answers 204 when the caller is current (or when nothing is published for
 * its platform) and a small JSON manifest when a newer version exists. The
 * manifest is the latest.json written by whereti's scripts\package.ps1
 * -Release, stored in KV under the key "latest". Same design as
 * releases.silentsilo.com.
 *
 * Security does not live here. Before installing anything, whereti checks
 * that the downloaded installer carries a valid Authenticode signature from
 * Software Hive S.R.L. and matches the SHA-256 in the manifest, so this
 * endpoint serving the wrong data can break updates but can never install
 * code.
 *
 * Each check writes one analytics datapoint: platform, installed version,
 * outcome. Deliberately nothing else. No IPs, no identifiers, no cookies.
 * Counting requests, not people, is the whole design.
 */

import { compareVersions, isVersion, normalize } from "./semver";

export interface Env {
  RELEASES: KVNamespace;
  UPDATE_CHECKS?: AnalyticsEngineDataset;
  // Set under [vars] in wrangler.toml; the defaults below only cover a
  // deployment where the vars are missing entirely.
  TARGETS?: string;
  ARCHS?: string;
  MANIFEST_CACHE_TTL_SECONDS?: string;
}

/** What the app needs to fetch and check one installer. Opaque here. */
type PlatformEntry = { url: string; sha256: string; size?: number };

type Manifest = {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, PlatformEntry>;
};

/** The KV key; package.json's publish:manifest writes the same one. */
const MANIFEST_KEY = "latest";

const DEFAULT_TARGETS = "windows";
const DEFAULT_ARCHS = "x86_64,aarch64";

/** KV refuses a cacheTtl under 60, which makes 60 the floor here too. */
const MIN_CACHE_TTL_SECONDS = 60;

function listFromVar(value: string | undefined, fallback: string): Set<string> {
  const raw = value?.trim() ? value : fallback;
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function ttlFromVar(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_CACHE_TTL_SECONDS ? parsed : MIN_CACHE_TTL_SECONDS;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) {
      return new Response("not found", { status: 404 });
    }
    const [target, arch, installed] = parts as [string, string, string];
    const targets = listFromVar(env.TARGETS, DEFAULT_TARGETS);
    const archs = listFromVar(env.ARCHS, DEFAULT_ARCHS);
    if (!targets.has(target) || !archs.has(arch) || !isVersion(installed)) {
      return new Response("not found", { status: 404 });
    }

    const manifest = await env.RELEASES.get<Manifest>(MANIFEST_KEY, {
      type: "json",
      cacheTtl: ttlFromVar(env.MANIFEST_CACHE_TTL_SECONDS),
    });

    // Only the caller's platform, and every variant of it: the hyphen keeps
    // `windows-x86` from matching `windows-x86_64`.
    const platformKey = `${target}-${arch}`;
    const platforms = Object.fromEntries(
      Object.entries(manifest?.platforms ?? {}).filter(
        ([key]) => key === platformKey || key.startsWith(`${platformKey}-`),
      ),
    );
    const offered = Object.keys(platforms).length > 0;

    let outcome: "no-release" | "up-to-date" | "update-offered";
    let response: Response;

    if (!manifest || !offered) {
      outcome = "no-release";
      response = new Response(null, { status: 204 });
    } else if (compareVersions(manifest.version, installed) <= 0) {
      outcome = "up-to-date";
      response = new Response(null, { status: 204 });
    } else {
      outcome = "update-offered";
      response = Response.json({
        version: normalize(manifest.version),
        notes: manifest.notes ?? "",
        pub_date: manifest.pub_date ?? "",
        platforms,
      });
    }

    env.UPDATE_CHECKS?.writeDataPoint({
      indexes: [platformKey],
      blobs: [target, arch, normalize(installed), outcome],
      doubles: [1],
    });

    return response;
  },
} satisfies ExportedHandler<Env>;
