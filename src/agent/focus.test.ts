import { describe, it, expect } from "vitest";
import { LIVE_TOOLS } from "@/agent/tools";
import { TOOL_CARDS, cardsInReply, cardsInText } from "@/agent/focus";

describe("where the agent is on the page", () => {
  it("knows the cards of every tool", () => {
    for (const t of LIVE_TOOLS) expect(TOOL_CARDS[t.name], t.name).toBeDefined();
    expect(TOOL_CARDS.refine).toEqual(["parameters", "pattern"]);
  });

  it("reads the cards a reply points to from its last paragraph", () => {
    const reply = "Stage 1 converged: wR 3.99%, GoF 3.04, with the background and scale refined.\n\nNext is the TOF profile: shall I free the peak widths in the parameters?";
    expect(cardsInReply(reply)).toEqual(["parameters"]);
    expect(cardsInText("The residual shows two peaks on the plot.")).toEqual(["pattern"]);
    expect(cardsInText("The instrument's wavelength is 1.54 Å.")).toEqual(["instrument"]);
    expect(cardsInReply("")).toEqual([]);
  });
});
