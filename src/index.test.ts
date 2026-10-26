import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

type DataPoint = { indexes?: string[]; blobs?: string[]; doubles?: number[] };
type Vars = Partial<Pick<Env, "TARGETS" | "ARCHS" | "MANIFEST_CACHE_TTL_SECONDS">>;

/** A manifest the way scripts\package.ps1 -Release writes it. */
const MANIFEST = {
  version: "0.2.0",
  notes: "notes",
  pub_date: "2026-11-01T10:00:00Z",
  platforms: {
    "windows-x86_64": {
      url: "https://github.com/whereti/whereti/releases/download/v0.2.0/whereti-setup-0.2.0.exe",
      sha256: "ab".repeat(32),
      size: 31_000_000,
    },
  },
};

function testEnv(manifest: unknown, vars: Vars = {}) {
  const points: DataPoint[] = [];
  const env = {
    RELEASES: { get: async () => manifest },
    UPDATE_CHECKS: { writeDataPoint: (p: DataPoint) => void points.push(p) },
    ...vars,
  } as unknown as Env;
  return { env, points };
}

function call(env: Env, path: string, method = "GET"): Promise<Response> {
  const request = new Request(`https://releases.whereti.com${path}`, { method }) as Parameters<
    typeof worker.fetch
  >[0];
  return worker.fetch(request, env);
}

describe("methods and routes", () => {
  it("rejects anything but GET and HEAD", async () => {
    const { env } = testEnv(MANIFEST);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await call(env, "/windows/x86_64/0.1.0", method)).status).toBe(405);
    }
  });

  it("answers HEAD like GET", async () => {
    const { env } = testEnv(null);
    expect((await call(env, "/windows/x86_64/0.1.0", "HEAD")).status).toBe(204);
  });

  it("has a health route", async () => {
    const res = await call(testEnv(null).env, "/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("404s anything that is not windows/arch/version, and records nothing", async () => {
    const { env, points } = testEnv(MANIFEST);
    for (const path of [
      "/",
      "/windows/x86_64",
      "/windows/x86_64/0.1.0/extra",
      "/linux/x86_64/0.1.0",
      "/windows/mips/0.1.0",
      "/windows/x86_64/latest",
      `/windows/x86_64/1.0.0-${"a".repeat(40)}`,
    ]) {
      expect((await call(env, path)).status).toBe(404);
    }
    expect(points).toHaveLength(0);
  });
});

describe("update decisions", () => {
  it("204s when nothing is published", async () => {
    const { env, points } = testEnv(null);
    expect((await call(env, "/windows/x86_64/0.1.0")).status).toBe(204);
    expect(points[0]?.blobs?.[3]).toBe("no-release");
  });

  it("204s when the manifest has nothing for the caller's architecture", async () => {
    const { env, points } = testEnv(MANIFEST);
    expect((await call(env, "/windows/aarch64/0.1.0")).status).toBe(204);
    expect(points[0]?.blobs?.[3]).toBe("no-release");
  });

  it("204s when the caller is current or ahead", async () => {
    const { env, points } = testEnv(MANIFEST);
    for (const installed of ["0.2.0", "0.3.0"]) {
      expect((await call(env, `/windows/x86_64/${installed}`)).status).toBe(204);
    }
    expect(points.map((p) => p.blobs?.[3])).toEqual(["up-to-date", "up-to-date"]);
  });

  it("offers the update with only the caller's own entry", async () => {
    const { env } = testEnv({
      ...MANIFEST,
      platforms: {
        ...MANIFEST.platforms,
        "windows-aarch64": { url: "https://example.com/arm.exe", sha256: "cd".repeat(32) },
      },
    });
    const res = await call(env, "/windows/x86_64/0.1.0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "0.2.0",
      notes: "notes",
      pub_date: "2026-11-01T10:00:00Z",
      platforms: { "windows-x86_64": MANIFEST.platforms["windows-x86_64"] },
    });
  });

  it("offers a release to its own prereleases and never the reverse", async () => {
    expect((await call(testEnv(MANIFEST).env, "/windows/x86_64/0.2.0-rc.1")).status).toBe(200);
    const rc = testEnv({ ...MANIFEST, version: "0.2.1-rc.1" });
    expect((await call(rc.env, "/windows/x86_64/0.2.0")).status).toBe(200);
    expect((await call(rc.env, "/windows/x86_64/0.2.1")).status).toBe(204);
  });

  it("normalizes a v prefix and fills in missing notes", async () => {
    const { env } = testEnv({ version: "v0.2.0", platforms: MANIFEST.platforms });
    const body = (await (await call(env, "/windows/x86_64/0.1.0")).json()) as Record<string, string>;
    expect(body.version).toBe("0.2.0");
    expect(body.notes).toBe("");
    expect(body.pub_date).toBe("");
  });

  it("never offers a manifest whose version does not parse", async () => {
    const { env } = testEnv({ ...MANIFEST, version: "garbage" });
    expect((await call(env, "/windows/x86_64/0.0.1")).status).toBe(204);
  });
});

describe("platform vocabulary from vars", () => {
  it("narrows to what the vars list", async () => {
    const { env } = testEnv(MANIFEST, { TARGETS: "windows", ARCHS: "x86_64" });
    expect((await call(env, "/windows/x86_64/0.1.0")).status).toBe(200);
    expect((await call(env, "/windows/aarch64/0.1.0")).status).toBe(404);
  });

  it("falls back to the defaults when vars are blank", async () => {
    const { env } = testEnv(MANIFEST, { TARGETS: "  ", ARCHS: undefined });
    expect((await call(env, "/windows/aarch64/0.1.0")).status).toBe(204);
    expect((await call(env, "/windows/x86_64/0.1.0")).status).toBe(200);
  });
});

describe("analytics", () => {
  it("writes exactly platform, version and outcome", async () => {
    const { env, points } = testEnv(MANIFEST);
    await call(env, "/windows/x86_64/v0.1.0");
    expect(points).toEqual([
      { indexes: ["windows-x86_64"], blobs: ["windows", "x86_64", "0.1.0", "update-offered"], doubles: [1] },
    ]);
  });

  it("still answers when the analytics binding is absent", async () => {
    const env = { RELEASES: { get: async () => MANIFEST } } as unknown as Env;
    expect((await call(env, "/windows/x86_64/0.1.0")).status).toBe(200);
  });
});
