import { describe, expect, it } from "vitest";
import {
  composeMotionFramePrompt,
  composeSpritePrompt,
} from "../../../sprite/comfyui/sprite-prompt.js";
import {
  SPRITE_BASE_NEGATIVE,
  SPRITE_BASE_POSITIVE,
  STYLE_PROFILES,
  VIEWPOINT_PROFILES,
} from "../../../sprite/comfyui/style-profiles.js";
import type { Style, Viewpoint } from "../../../sprite/types.js";

// Prompt composition is pure text, so it is asserted as text. These tests guard
// the properties the prompt-engineering review fixed in place: fragment ORDER,
// the independence of the style and viewpoint axes, and the fact that nothing
// in the motion half assumes a biped.

const STYLES = Object.keys(STYLE_PROFILES) as Style[];
const VIEWPOINTS = Object.keys(VIEWPOINT_PROFILES) as Viewpoint[];

describe("composeSpritePrompt", () => {
  it("puts the caller's subject first, then style, then viewpoint, then base", () => {
    const { positive } = composeSpritePrompt({
      prompt: "a green pixel serpent",
      style: "16bit",
      viewpoint: "side",
    });

    expect(positive).toBe(
      [
        "a green pixel serpent",
        ...STYLE_PROFILES["16bit"].positive,
        ...VIEWPOINT_PROFILES.side.positive,
        ...SPRITE_BASE_POSITIVE,
      ].join(", "),
    );
  });

  it("keeps the style and viewpoint axes independent across every combination", () => {
    for (const style of STYLES) {
      for (const viewpoint of VIEWPOINTS) {
        const { positive, negative } = composeSpritePrompt({ prompt: "x", style, viewpoint });
        // Each table contributes its own fragments and only its own: swapping
        // one axis can never add or remove a fragment owned by the other.
        for (const fragment of STYLE_PROFILES[style].positive) {
          expect(positive).toContain(fragment);
        }
        for (const fragment of VIEWPOINT_PROFILES[viewpoint].positive) {
          expect(positive).toContain(fragment);
        }
        for (const fragment of SPRITE_BASE_NEGATIVE) {
          expect(negative).toContain(fragment);
        }
      }
    }
  });

  it("omits an absent caller negative rather than emitting a dangling separator", () => {
    const { negative } = composeSpritePrompt({ prompt: "x", style: "chibi", viewpoint: "topdown" });
    expect(negative.startsWith(STYLE_PROFILES.chibi.negative[0])).toBe(true);
    expect(negative).not.toContain(", ,");
  });
});

describe("composeMotionFramePrompt", () => {
  const BASE = { prompt: "a green pixel serpent", motionState: "slither" };

  it("emits no phase cue for a single-frame state", () => {
    expect(composeMotionFramePrompt({ ...BASE, frameIndex: 0, framesPerState: 1 })).toBe(
      "a green pixel serpent, slither animation pose",
    );
  });

  it("orders subject, then motion, then phase", () => {
    const prompt = composeMotionFramePrompt({ ...BASE, frameIndex: 0, framesPerState: 4 });
    expect(prompt).toBe(
      "a green pixel serpent, slither animation pose, at the start of the motion, motion phase 1",
    );
    expect(prompt.indexOf("serpent")).toBeLessThan(prompt.indexOf("slither"));
    expect(prompt.indexOf("slither")).toBeLessThan(prompt.indexOf("motion phase"));
  });

  it("walks the phase descriptors from start to end across a state", () => {
    const prompts = [0, 1, 2, 3].map((frameIndex) =>
      composeMotionFramePrompt({ ...BASE, frameIndex, framesPerState: 4 }),
    );
    expect(prompts).toEqual([
      "a green pixel serpent, slither animation pose, at the start of the motion, motion phase 1",
      "a green pixel serpent, slither animation pose, early in the motion, motion phase 2",
      "a green pixel serpent, slither animation pose, late in the motion, motion phase 3",
      "a green pixel serpent, slither animation pose, at the end of the motion, motion phase 4",
    ]);
  });

  it("always anchors the first frame at the start and the last at the end", () => {
    for (let framesPerState = 2; framesPerState <= 12; framesPerState++) {
      const first = composeMotionFramePrompt({ ...BASE, frameIndex: 0, framesPerState });
      const last = composeMotionFramePrompt({
        ...BASE,
        frameIndex: framesPerState - 1,
        framesPerState,
      });
      expect(first).toContain("at the start of the motion");
      expect(last).toContain("at the end of the motion");
    }
  });

  it("gives every frame of a state a distinct prompt, past the descriptor count", () => {
    // Load-bearing: with a fixed seed and a chained reference, two frames with
    // identical prompts have nothing left to separate them.
    const framesPerState = 12;
    const prompts = Array.from({ length: framesPerState }, (_, frameIndex) =>
      composeMotionFramePrompt({ ...BASE, frameIndex, framesPerState }),
    );
    expect(new Set(prompts).size).toBe(framesPerState);
  });

  it("never emits a count-of-total ordinal that reads as a contact-sheet caption", () => {
    const prompt = composeMotionFramePrompt({ ...BASE, frameIndex: 1, framesPerState: 4 });
    expect(prompt).not.toContain("2 of 4");
  });

  it("passes arbitrary non-humanoid motion vocabulary through unnarrowed", () => {
    const states = ["slither", "flap", "glide", "shed skin", "cast_spell", "spin", "pulse"];
    for (const motionState of states) {
      const prompt = composeMotionFramePrompt({
        ...BASE,
        motionState,
        frameIndex: 0,
        framesPerState: 2,
      });
      expect(prompt).toContain(motionState.replace(/_/g, " "));
    }
  });

  it("humanizes underscores and dashes and collapses whitespace", () => {
    expect(
      composeMotionFramePrompt({
        ...BASE,
        motionState: "  coil--strike_hard  ",
        frameIndex: 0,
        framesPerState: 1,
      }),
    ).toBe("a green pixel serpent, coil strike hard animation pose");
  });

  it("drops the motion fragment entirely when the state humanizes to nothing", () => {
    expect(
      composeMotionFramePrompt({ ...BASE, motionState: " _ ", frameIndex: 0, framesPerState: 1 }),
    ).toBe("a green pixel serpent");
  });

  it("contributes no gait, limb, or biped vocabulary of its own", () => {
    // The subject is the ONLY place a body plan may be named. Guards against a
    // future "walk cycle" / "stance" / "footfall" creeping into the template.
    const banned = ["walk", "step", "stride", "stance", "foot", "leg", "arm", "hand", "biped"];
    const prompt = composeMotionFramePrompt({
      prompt: "an arrow projectile",
      motionState: "spin",
      frameIndex: 1,
      framesPerState: 3,
    }).replace("an arrow projectile", "");
    for (const word of banned) {
      expect(prompt).not.toContain(word);
    }
  });

  it("contributes no style or viewpoint fragment, so the axes stay downstream", () => {
    const motionPrompt = composeMotionFramePrompt({ ...BASE, frameIndex: 1, framesPerState: 3 });
    for (const style of STYLES) {
      for (const fragment of STYLE_PROFILES[style].positive) {
        expect(motionPrompt).not.toContain(fragment);
      }
    }
    for (const viewpoint of VIEWPOINTS) {
      for (const fragment of VIEWPOINT_PROFILES[viewpoint].positive) {
        expect(motionPrompt).not.toContain(fragment);
      }
    }
  });

  it("survives composition into the full sprite prompt without duplicating fragments", () => {
    const subject = composeMotionFramePrompt({ ...BASE, frameIndex: 1, framesPerState: 3 });
    const { positive } = composeSpritePrompt({
      prompt: subject,
      style: "16bit",
      viewpoint: "topdown",
    });
    expect(positive.startsWith(subject)).toBe(true);
    for (const fragment of [...STYLE_PROFILES["16bit"].positive, ...SPRITE_BASE_POSITIVE]) {
      expect(positive.split(fragment).length - 1).toBe(1);
    }
  });
});
