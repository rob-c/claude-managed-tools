/**
 * Who owns the deadline, and which shell the child runs in.
 *
 * The invariant under every branch: the applet's deadline is the smaller number, because
 * only the applet prints the timeline when it fires.
 */
import { describe, expect, test } from "claude-code/testing";
import { HOST_GRACE_SECONDS, planDeadline, shellCandidates } from "../src/policy";

describe("the deadline plan", () => {
	test("a caller's timeout is taken over one second early, and the host keeps its own", () => {
		expect(planDeadline({ askedMs: 30_000, defaultSeconds: 120 })).toEqual({
			budgetSeconds: 29,
			hostTimeoutMs: 30_000,
			source: "caller",
		});
		// Never zero: `--timeout 0` would mean no deadline at all.
		expect(planDeadline({ askedMs: 800, defaultSeconds: 120 }).budgetSeconds).toBe(1);
	});

	test("a caller's timeout above the host's ceiling is clamped as the host clamps it", () => {
		const plan = planDeadline({ askedMs: 3_600_000, defaultSeconds: 120 });
		expect(plan.hostTimeoutMs).toBe(600_000);
		expect(plan.budgetSeconds).toBe(599);
		// The ceiling moves with the environment.
		expect(planDeadline({ askedMs: 3_600_000, defaultSeconds: 120, hostMaxMs: 900_000 }).budgetSeconds).toBe(899);
	});

	test("the plugin's default owns the deadline and gives the host a grace past it", () => {
		expect(planDeadline({ defaultSeconds: 120 })).toEqual({
			budgetSeconds: 120,
			hostTimeoutMs: (120 + HOST_GRACE_SECONDS) * 1000,
			source: "default",
		});
	});

	test("a default the host could not honour is cut to what fits under its ceiling", () => {
		const plan = planDeadline({ defaultSeconds: 3_600 });
		expect(plan.budgetSeconds).toBe(600 - HOST_GRACE_SECONDS);
		expect(plan.hostTimeoutMs).toBe(600_000);
	});

	test("with no default of ours the host's applies, still pre-empted by a second", () => {
		expect(planDeadline({ defaultSeconds: 0 })).toEqual({ budgetSeconds: 119, hostTimeoutMs: undefined, source: "host" });
		expect(planDeadline({ defaultSeconds: 0, hostDefaultMs: 45_000 }).budgetSeconds).toBe(44);
	});

	test("the applet's deadline is always the smaller one", () => {
		const cases = [
			{ askedMs: 5_000, defaultSeconds: 120 },
			{ askedMs: 600_000, defaultSeconds: 0 },
			{ defaultSeconds: 1 },
			{ defaultSeconds: 590 },
			{ defaultSeconds: 100_000 },
			{ defaultSeconds: 0, hostDefaultMs: 2_000 },
		];
		for (const input of cases) {
			const plan = planDeadline(input);
			const host = plan.hostTimeoutMs ?? input.hostDefaultMs ?? 120_000;
			expect(plan.budgetSeconds * 1000 < host).toBe(true);
			expect(plan.budgetSeconds >= 1).toBe(true);
		}
	});
});

describe("the child's shell", () => {
	test("the person's bash or zsh comes first, as the host itself would pick", () => {
		expect(shellCandidates({ SHELL: "/bin/zsh" })[0]).toBe("/bin/zsh");
		expect(shellCandidates({ SHELL: "/bin/zsh", CLAUDE_CODE_SHELL: "/opt/homebrew/bin/bash" }).slice(0, 2)).toEqual([
			"/opt/homebrew/bin/bash",
			"/bin/zsh",
		]);
	});

	test("a shell the host would not use is skipped, and bash is the fallback", () => {
		expect(shellCandidates({ SHELL: "/opt/homebrew/bin/fish" })[0]).toBe("/bin/bash");
		expect(shellCandidates({ SHELL: "zsh" })[0]).toBe("/bin/bash");
		expect(shellCandidates({})).toEqual(["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/bin/sh"]);
	});

	test("no path is tried twice", () => {
		const list = shellCandidates({ SHELL: "/bin/bash", CLAUDE_CODE_SHELL: "/bin/bash" });
		expect(new Set(list).size).toBe(list.length);
	});
});
