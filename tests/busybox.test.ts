/**
 * Finding the binary and naming its release asset.
 *
 * A host BusyBox is not this build: only one whose `--caps` lists `run` can wrap.
 */
import { describe, expect, test } from "claude-code/testing";
import {
	assetPattern,
	busyboxTarget,
	candidatePaths,
	installedPath,
	parseCaps,
	parseDigest,
	parseShaOutput,
	pickAsset,
} from "../src/busybox";

const SHA = "a".repeat(64);

function release(assets: Array<Record<string, unknown>>): string {
	return JSON.stringify({ tag_name: "v0.5.0", assets });
}

describe("where the binary is looked for", () => {
	test("an explicit setting first, then this plugin's own copy, then pi's", () => {
		// Ours is the one the plugin keeps at the latest release and has verified.
		expect(
			candidatePaths({ option: "/opt/bb/busybox", env: "/env/busybox", dataDir: "/data/", home: "/home/me" }),
		).toEqual(["/opt/bb/busybox", "/env/busybox", "/data/bin/busybox", "/home/me/.pi/agent/bin/busybox"]);
		expect(installedPath("/data")).toBe("/data/bin/busybox");
	});

	test("a relative or empty path is never a candidate, and nothing is tried twice", () => {
		expect(candidatePaths({ option: "busybox", env: "  ", home: "/h" })).toEqual(["/h/.pi/agent/bin/busybox"]);
		expect(candidatePaths({ option: "/h/.pi/agent/bin/busybox", home: "/h" })).toEqual(["/h/.pi/agent/bin/busybox"]);
		expect(candidatePaths({})).toEqual([]);
	});
});

describe("which build can wrap", () => {
	test("run and log must both be there", () => {
		const caps = parseCaps('{"schema":1,"version":"1.39.0.git","features":["peek","run","log","json"]}');
		expect(caps.ok).toBe(true);
		expect(caps.version).toBe("1.39.0.git");
		expect(parseCaps('{"version":"1.39.0","features":["run"]}').ok).toBe(false);
	});

	test("a host BusyBox, which prints usage instead of JSON, is not our build", () => {
		expect(parseCaps("BusyBox v1.36.1 multi-call binary.").ok).toBe(false);
		expect(parseCaps("").ok).toBe(false);
		expect(parseCaps('{"features":"run"}').ok).toBe(false);
	});
});

describe("the release asset", () => {
	test("uname names the target; macOS is one universal binary", () => {
		expect(busyboxTarget("Darwin\n", "arm64\n")).toBe("darwin-universal");
		expect(busyboxTarget("Darwin", "x86_64")).toBe("darwin-universal");
		expect(busyboxTarget("Linux", "aarch64")).toBe("linux-arm64");
		expect(busyboxTarget("Linux", "x86_64")).toBe("linux-amd64");
		expect(busyboxTarget("Linux", "riscv64")).toBe(undefined);
		expect(busyboxTarget("MINGW64_NT", "x86_64")).toBe(undefined);
	});

	test("the asset is matched by pattern, and the -pure variant is not it", () => {
		const pattern = assetPattern("darwin-universal");
		expect(pattern.test("busybox-static-1.39.0-aac079e-darwin-universal")).toBe(true);
		expect(pattern.test("busybox-static-1.39.0-darwin-universal")).toBe(true);
		expect(pattern.test("busybox-static-1.39.0-aac079e-darwin-universal-pure")).toBe(false);
		expect(pattern.test("busybox-static-1.39.0-aac079e-linux-amd64")).toBe(false);
	});

	test("picks this machine's asset with its digest", () => {
		const url = "https://github.com/rob-c/busybox-static/releases/download/v0.5.0/busybox-static-1.39.0-aac079e-linux-amd64";
		const picked = pickAsset(
			release([
				{ name: "busybox-static-1.39.0-aac079e-linux-amd64-pure", browser_download_url: `${url}-pure`, digest: `sha256:${SHA}` },
				{ name: "busybox-static-1.39.0-aac079e-linux-amd64", browser_download_url: url, digest: `sha256:${SHA}` },
			]),
			"linux-amd64",
		);
		expect(picked).toEqual({ tag: "v0.5.0", name: "busybox-static-1.39.0-aac079e-linux-amd64", url, sha256: SHA });
	});

	test("a download that is not from the project's own releases is not picked", () => {
		const name = "busybox-static-1.39.0-aac079e-linux-amd64";
		expect(pickAsset(release([{ name, browser_download_url: `https://example.com/${name}`, digest: `sha256:${SHA}` }]), "linux-amd64")).toBe(undefined);
		expect(pickAsset(release([{ name, browser_download_url: `https://github.com/someone/else/releases/download/v1/${name}` }]), "linux-amd64")).toBe(undefined);
	});

	test("a payload that is not a release is no asset, not a crash", () => {
		expect(pickAsset("not json", "linux-amd64")).toBe(undefined);
		expect(pickAsset('{"message":"rate limit"}', "linux-amd64")).toBe(undefined);
		expect(pickAsset(release([]), "linux-amd64")).toBe(undefined);
	});

	test("only a sha256 digest counts, and shasum's output is read by its hex", () => {
		expect(parseDigest(`sha256:${SHA.toUpperCase()}`)).toBe(SHA);
		expect(parseDigest(`sha1:${"b".repeat(40)}`)).toBe(undefined);
		expect(parseDigest("sha256:short")).toBe(undefined);
		expect(parseDigest(undefined)).toBe(undefined);
		expect(parseShaOutput(`${SHA}  /data/bin/busybox.download\n`)).toBe(SHA);
		expect(parseShaOutput("shasum: no such file")).toBe(undefined);
	});
});
