import { describe, it, expect } from "vitest";
import { ComputeClient } from "@/workers/computeClient";
import { mn3gaSession } from "@/agent/evals/pages";
import { executor, fakeHost, headlessHistory, sessionPort } from "@/testSupport/agentHeadless";
import { powderRestraints } from "@/app/powderSpec";
import { DEFAULT_INSTRUMENT, type Session } from "@/app/powderSession";
import { posteriorRun, powderFit, thoroughFit, withBackgroundType, withPhase, type PowderCompute, type PowderPageModel } from "@/app/powderPage";

/**
 * The powder page's operations, which the workbench and the Agent's headless
 * page both call: each request carries what the page's fit depends on. A copy
 * of these in the headless page once dropped the window (refine), the extra
 * phases and the magnetic model (the posterior), the restraints of every
 * phase but the first, and the Lorentzian part and background type of the
 * profile; the evals and the validation ran on that copy.
 */

/** The real client, each request it is asked for recorded. */
function recording(): { client: PowderCompute; requests: { call: string; req: Record<string, unknown> }[] } {
  const real = new ComputeClient();
  const requests: { call: string; req: Record<string, unknown> }[] = [];
  const watch = <K extends keyof PowderCompute>(call: K) => ((req: Record<string, unknown>, ...rest: unknown[]) => {
    requests.push({ call, req });
    return (real[call] as (...a: unknown[]) => unknown).call(real, req, ...rest);
  }) as unknown as PowderCompute[K];
  const client = {
    refinePowderParallel: watch("refinePowderParallel"),
    refineMagneticPowderParallel: watch("refineMagneticPowderParallel"),
    leBailPrefit: watch("leBailPrefit"),
    refinePowderMultiStart: watch("refinePowderMultiStart"),
    refineMagneticPowderMultiStart: watch("refineMagneticPowderMultiStart"),
    samplePowderPosterior: watch("samplePowderPosterior"),
    sampleMagneticPowderPosterior: watch("sampleMagneticPowderPosterior"),
  } as PowderCompute;
  return { client, requests };
}

/** The demo with a second phase and occupancy ties on, a log-interpolated background, and the cell free. */
function busySession(): Session {
  const s0 = mn3gaSession();
  const second = { ...s0.structure, id: "second", name: "Second" };
  const s1 = withBackgroundType(withPhase({ ...s0, siteTies: { ...s0.siteTies, occupancyToUnity: true } }, second, DEFAULT_INSTRUMENT), "logInterpolate");
  return { ...s1, powderParams: s1.powderParams.map((p) => (p.kind === "cellLength" ? { ...p, fixed: false } : p)) };
}

describe("the powder page's fits", () => {
  it("every request carries the window, every phase, every phase's restraints and the whole profile", async () => {
    const session = busySession();
    const page: PowderPageModel = { session, instrument: DEFAULT_INSTRUMENT, fitRange: { min: 20, max: 100 }, result: null };
    const { client, requests } = recording();
    await powderFit(client, page, { maxIterations: 2 });
    await thoroughFit(client, page);
    await posteriorRun(client, page)({ nSteps: 2, seed: 1 });
    expect(requests.map((r) => r.call)).toEqual(["refinePowderParallel", "refinePowderMultiStart", "samplePowderPosterior"]);
    const restraints = powderRestraints([session.structure, ...session.extraPhases], session.siteTies, session.powderParams);
    for (const { call, req } of requests) {
      expect(req.fitRange, call).toEqual({ min: 20, max: 100 });
      expect((req.extraPhases as unknown[]).length, call).toBe(1);
      expect(req.backgroundType, call).toBe("logInterpolate");
      expect(req.lorentz, call).toBe(session.powderProfile.lorentz);
      expect(req.restraints ?? [], call).toEqual(restraints);
    }
  }, 120_000);

  it("Prefit runs the Le Bail cell inside the window, then the multi-start from its cell", async () => {
    const s = mn3gaSession();
    const session = { ...s, powderParams: s.powderParams.map((p) => (p.kind === "cellLength" ? { ...p, fixed: false } : p)) };
    const { client, requests } = recording();
    const out = await thoroughFit(client, { session, instrument: DEFAULT_INSTRUMENT, fitRange: { min: 15, max: 110 }, result: null });
    expect(requests.map((r) => r.call)).toEqual(["leBailPrefit", "refinePowderMultiStart"]);
    expect(requests[0]!.req.fitRange).toEqual({ min: 15, max: 110 });
    expect(out.mode).toBe("prefit");
    expect(out.message).toMatch(/^Prefit/);
  }, 120_000);
});

describe("the Agent's headless powder page runs the page's operations", () => {
  it("applies what each control does (the copy only logged the background, microstrain and ADP controls)", () => {
    const { port } = sessionPort(mn3gaSession());
    const rows = (): number => port.state().parameters.filter((p) => p.kind === "background").length;
    port.setBackgroundTerms(rows() + 2);
    expect(port.state().settings.backgroundTerms).toBe(rows());
    port.setBackgroundType("linInterpolate");
    expect(port.state().settings.backgroundType).toBe("linInterpolate");
    port.setMustrain("uniaxial");
    expect(port.state().settings.mustrain).toBe("uniaxial");
    port.setAnisotropicAdp(true);
    expect(port.state().settings.anisotropicAdp).toBe(true);
  });

  it("samples the posterior over the window it fits", async () => {
    const { client, requests } = recording();
    const { port } = sessionPort(mn3gaSession(), DEFAULT_INSTRUMENT, { client });
    port.setFitRange({ min: 20, max: 100 });
    await port.refine();
    await port.samplePosterior!({ continue: false, steps: 2 });
    expect(requests.map((r) => [r.call, r.req.fitRange])).toEqual([["refinePowderParallel", { min: 20, max: 100 }], ["samplePowderPosterior", { min: 20, max: 100 }]]);
    expect(port.state().observationCount).toBeLessThan(port.state().curves.x.length);
  }, 120_000);
});

describe("the Agent's headless page and the History", () => {
  it("goes back to a step as the app does: its state on the page, the History's current step moved (it once did nothing)", async () => {
    const { port } = sessionPort(mn3gaSession());
    const history = headlessHistory(port);
    const { host } = fakeHost(port, history.history, (kind, agent) => history.record(kind, agent ? "agent" : undefined), history.goTo);
    const { ex } = executor(host, "auto");
    await ex.run("refine", {});
    history.record("refine", "agent", "Refine");
    const first = history.history()!.current;
    const after1 = port.state().parameters.map((p) => p.value);
    expect(port.state().parameters.filter((p) => p.kind === "bIso" && !p.fixed)).toEqual([]);
    await ex.run("set_free", { free: ["B_*"] });
    await ex.run("refine", {});
    history.record("refine", "agent", "Refine");
    expect(port.state().parameters.map((p) => p.value)).not.toEqual(after1);
    const back = await ex.run("go_to_step", { step: first });
    expect(back.isError, back.text).toBe(false);
    expect(history.history()!.current).toBe(first);
    expect(port.state().parameters.map((p) => p.value)).toEqual(after1);
    expect(port.state().parameters.filter((p) => p.kind === "bIso" && !p.fixed)).toEqual([]);
  }, 120_000);
});
