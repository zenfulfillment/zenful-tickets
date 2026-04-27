// Persona — animated AI orb backed by AbstractBall (Glob).
//
// Starting point: a single shared preset matching the user's tuned defaults.
// All states / variants render the same look right now; we'll branch them out
// step-by-step as we lock in the per-state behaviour.
//
// Defaults captured from the user's tuning session:
//   Setup  → speed 35, morph 3.5, dnoise 2.5
//   RGB    → r -3, g -2, b 15, n (black) 0, m (chrome) 6
//   Sphere → wireframe on, points on, point-size 1
//   Camera → guide on

import { AbstractBall, type AbstractBallProps } from "./AbstractBall";

export type PersonaState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "asleep";

export type PersonaVariant = "halo" | "obsidian";

interface PersonaProps {
  variant?: PersonaVariant;
  state?: PersonaState;
  className?: string;
  /** Live amplitude ref (0..1) — voice / typing / focus signals. Mutate
   *  directly without setState; the shader smooths it into morph + speed
   *  + zoom each frame. */
  levelRef?: React.MutableRefObject<number>;
  /** Live pointer ref in [-1..1] inside the orb's bounding box. Mutate the
   *  ref directly from mouse handlers (no setState) — the AbstractBall reads
   *  it each animation frame, so the orb reacts at GPU rate without ever
   *  triggering a React re-render. */
  pointerRef?: React.MutableRefObject<{ x: number; y: number } | null>;
}

// User-tuned baseline.
//
// Colour philosophy (matching the cyan + magenta Siri-orb reference):
//   - baseColor sets the dim-region floor (a soft purple/blue) so the orb
//     never goes black — that's the single biggest fix for the "luminous
//     glass" look.
//   - Chroma RGB values are mid-range: high enough that the noise creates
//     visible colour zones, low enough that the bands stay smooth (not
//     speckly).
//   - r/g/b use different scales so the patterns decorrelate — that's what
//     produces a pink side (r + b) and a cyan side (g + b) on the same orb.
const BASELINE: AbstractBallProps = {
  perlinTime: 35,
  perlinMorph: 3.5,
  perlinDNoise: 2.5,
  chromaRGBr: 6.5,
  chromaRGBg: 4.5,
  chromaRGBb: 7.5,
  chromaRGBn: 0.5,
  chromaRGBm: 1.2,
  sphereWireframe: false,
  spherePoints: false,
  spherePsize: 1,
  cameraSpeedY: 0,
  cameraSpeedX: 0,
  // Camera distance. Sphere radius is 20 (geometry hard-coded in AbstractBall);
  // with fov 20° we need enough distance that sphere diameter fits the canvas
  // with halo room. ~150 keeps the orb circular at every container size we use
  // (140–240 px) without clipping at the edges.
  cameraZoom: 150,
  cameraGuide: true,
  // Soft purple-pink-blue floor — tuned so dark regions read as a luminous
  // lavender instead of black, matching the Siri orb reference. Components
  // are 0..1; together they sum below 2.0 so highlights still have headroom.
  baseColor: [0.45, 0.30, 0.65],
  // ── In-shader rim only ──────────────────────────────────────────────────
  // Lightning streaks + moving specular were too busy and introduced the
  // muddy dark zones in the centre. Disabled. Just a very gentle fresnel
  // rim now — enough to suggest the orb is a 3D body without darkening it.
  rimStrength: 0.18,
  rimColor: [1.0, 0.92, 1.0],
  lightningStrength: 0,
  specStrength: 0,
};

// Per-state overrides on top of BASELINE. Only the fields that change per
// state need to live here; everything else is inherited. AbstractBall smooths
// transitions to these values (frame-rate-independent ease) so swapping
// state glides instead of snapping. The live `level` ref adds an extra
// dynamic boost on top of these in the animate loop.
const STATE_PRESETS: Record<PersonaState, Partial<AbstractBallProps>> = {
  idle: {},
  // Listening: slightly faster, slightly more morph, camera barely pulls
  // in. The level-driven boost in AbstractBall layers the live amplitude on
  // top — keeping this preset modest leaves headroom so a loud voice peak
  // or typing spike doesn't push the orb past the container edges.
  listening: {
    perlinTime: 48,
    perlinMorph: 4.2,
    cameraZoom: 145,
  },
  // Stubs for the other states — refined when we get to them.
  thinking: {
    perlinTime: 28,
    perlinMorph: 3.0,
    perlinDNoise: 4.0,
  },
  speaking: {
    perlinTime: 70,
    perlinMorph: 7.0,
    cameraZoom: 125,
  },
  asleep: {
    perlinTime: 8,
    perlinMorph: 1.5,
  },
};

export function Persona({
  className,
  state = "idle",
  pointerRef,
  levelRef,
}: PersonaProps) {
  const config = { ...BASELINE, ...STATE_PRESETS[state] };
  // Hover behaviour now lives entirely inside the shader. The pointer ref is
  // read every frame on the GPU side; we don't bounce mouse events through
  // React state at all, which means no per-move re-renders and no laggy CSS
  // transitions. The orb itself bulges toward the cursor and brightens in
  // that direction.
  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        filter: "drop-shadow(0 0 22px rgba(180,140,255,0.40))",
        isolation: "isolate",
      }}
    >
      <AbstractBall {...config} pointerRef={pointerRef} levelRef={levelRef} />
      {/* Static glass-shell highlight — top gloss, always there. The
          interactive cursor highlight lives in the shader. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: "8%",
          left: "30%",
          width: "30%",
          height: "16%",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at center, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.18) 40%, transparent 75%)",
          filter: "blur(5px)",
          mixBlendMode: "screen",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
