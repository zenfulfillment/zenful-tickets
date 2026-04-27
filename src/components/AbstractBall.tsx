// AbstractBall — port of cameronking4/openai-realtime-blocks `glob` component.
//
// Differences from the upstream version:
//   * Shaders inlined as JS string constants instead of <script id="..."> tags
//     read out of the DOM at mount. The DOM-script approach race-conditions
//     against React StrictMode and breaks entirely in some WebView builds.
//   * Three.js scene initialised once on mount; props are tracked via a ref
//     so changing perlin / chroma / zoom values update uniforms live without
//     tearing down and rebuilding the WebGL context on every render.
//   * Cleanup is defensive (the canvas is removed only if it's still parented).

import { useEffect, useRef } from "react";
import * as THREE from "three";

export interface AbstractBallProps {
  /** Speed of vertex-noise time progression. Higher = faster wobble. */
  perlinTime?: number;
  /** Vertex deformation amplitude. Higher = more dramatic surface morph. */
  perlinMorph?: number;
  /** Subtractive displacement noise. Subtle texture grain. */
  perlinDNoise?: number;
  /** Per-channel chromatic noise scale. Pushed apart = more colourful. */
  chromaRGBr?: number;
  chromaRGBg?: number;
  chromaRGBb?: number;
  chromaRGBn?: number;
  chromaRGBm?: number;
  sphereWireframe?: boolean;
  spherePoints?: boolean;
  spherePsize?: number;
  cameraSpeedY?: number;
  cameraSpeedX?: number;
  /** Distance from the sphere — bigger value = orb appears smaller. */
  cameraZoom?: number;
  /** Upstream demo flag — currently a no-op pass-through. Kept for prop parity. */
  cameraGuide?: boolean;
  /** RGB triple in 0..1. Floors the orb's dark regions so they tint to this
   *  colour instead of clamping to pure black — the difference between an
   *  orb that "goes dark" and one that's a luminous translucent body. */
  baseColor?: [number, number, number];
  /** Fresnel rim-glow intensity (0..1+). 0 disables. */
  rimStrength?: number;
  /** RGB triple — colour added at the rim. */
  rimColor?: [number, number, number];
  /** Animated bright-noise streak intensity (0..1+). 0 disables. */
  lightningStrength?: number;
  /** Moving pinpoint specular intensity (0..1+). 0 disables. */
  specStrength?: number;
  /** Live pointer in [-1..1] inside the orb's bounding box, or null when the
   *  cursor isn't over the orb. Read by the render loop each frame, never via
   *  React state — so the orb reacts at GPU rate instead of triggering a tree
   *  re-render per mouse-move event. */
  pointerRef?: React.MutableRefObject<{ x: number; y: number } | null>;
  /** Live amplitude in 0..1 (mic level, typing energy, etc). Read by the
   *  render loop each frame and added on top of the state's perlin values —
   *  so the orb breathes with the input signal without re-rendering. */
  levelRef?: React.MutableRefObject<number>;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULTS: Required<
  Omit<AbstractBallProps, "className" | "style" | "pointerRef" | "levelRef">
> = {
  perlinTime: 25.0,
  perlinMorph: 25.0,
  perlinDNoise: 0.0,
  chromaRGBr: 7.5,
  chromaRGBg: 5.0,
  chromaRGBb: 7.0,
  chromaRGBn: 1.0,
  chromaRGBm: 1.0,
  sphereWireframe: false,
  spherePoints: false,
  spherePsize: 1.0,
  cameraSpeedY: 0.0,
  cameraSpeedX: 0.0,
  cameraZoom: 150,
  cameraGuide: false,
  baseColor: [0, 0, 0] as [number, number, number],
  rimStrength: 0,
  rimColor: [1, 1, 1] as [number, number, number],
  lightningStrength: 0,
  specStrength: 0,
};

export function AbstractBall(props: AbstractBallProps) {
  // Merge props with defaults each render — cheap, and keeps a stable shape
  // for the propsRef. pointerRef is intentionally outside DEFAULTS so it
  // stays optional / undefined when callers don't want hover reactivity.
  const merged = { ...DEFAULTS, ...props } as Required<
    Omit<AbstractBallProps, "className" | "style" | "pointerRef" | "levelRef">
  > &
    Pick<AbstractBallProps, "pointerRef" | "levelRef">;

  const mountRef = useRef<HTMLDivElement>(null);
  // Live snapshot of props the animate loop reads from each frame. Updating
  // this ref doesn't re-trigger the init useEffect so the WebGL context lives
  // its full life across prop changes.
  const propsRef = useRef(merged);
  propsRef.current = merged;

  // One-shot init of Three.js scene, geometry, material, and animation loop.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth || 1;
    const height = mount.clientHeight || 1;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(20, width / height, 1, 1000);
    camera.position.set(0, 10, propsRef.current.cameraZoom);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const geometry = new THREE.IcosahedronGeometry(20, 20);

    const uniforms = {
      time:      { value: 0.0 },
      RGBr:      { value: propsRef.current.chromaRGBr / 10 },
      RGBg:      { value: propsRef.current.chromaRGBg / 10 },
      RGBb:      { value: propsRef.current.chromaRGBb / 10 },
      RGBn:      { value: propsRef.current.chromaRGBn / 100 },
      RGBm:      { value: propsRef.current.chromaRGBm },
      morph:     { value: propsRef.current.perlinMorph },
      dnoise:    { value: propsRef.current.perlinDNoise },
      psize:     { value: propsRef.current.spherePsize },
      baseColor: {
        value: new THREE.Vector3(
          propsRef.current.baseColor[0],
          propsRef.current.baseColor[1],
          propsRef.current.baseColor[2],
        ),
      },
      rimStrength: { value: propsRef.current.rimStrength },
      rimColor: {
        value: new THREE.Vector3(
          propsRef.current.rimColor[0],
          propsRef.current.rimColor[1],
          propsRef.current.rimColor[2],
        ),
      },
      lightningStrength: { value: propsRef.current.lightningStrength },
      specStrength: { value: propsRef.current.specStrength },
      uPointer: { value: new THREE.Vector2(0, 0) },
      uPointerActive: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      side: THREE.DoubleSide,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      wireframe: propsRef.current.sphereWireframe,
    });

    const mesh = new THREE.Mesh(geometry, material);
    const point = new THREE.Points(geometry, material);
    scene.add(mesh);
    scene.add(point);

    let raf = 0;
    let lastTime = performance.now();
    // Smoothed speed/morph/dnoise/zoom — eased toward (preset + level-boost)
    // each frame so state changes glide instead of snapping and live audio
    // level doesn't crackle the morph.
    let curSpeed = propsRef.current.perlinTime;
    let curMorph = propsRef.current.perlinMorph;
    let curDNoise = propsRef.current.perlinDNoise;
    let curZoom = propsRef.current.cameraZoom;
    const animate = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      const p = propsRef.current;

      // Live audio / typing amplitude.  ref-driven, no React in the path.
      const level = Math.max(0, Math.min(1, p.levelRef?.current ?? 0));

      // Targets = state preset (from props) + level boost. Boosts are kept
      // modest so a typing-spike or loud voice peak doesn't blow the orb
      // past the container edges (we already had clipping problems before).
      // The state preset itself does most of the visual lift; the level
      // adds the live "breathing" on top.
      const targetSpeed = p.perlinTime + level * 18;
      const targetMorph = p.perlinMorph + level * 2.5;
      const targetDNoise = p.perlinDNoise;
      const targetZoom = p.cameraZoom - level * 8;

      // Frame-rate-independent ease toward targets.
      const k = 1 - Math.exp(-dt * 8);
      curSpeed  += (targetSpeed  - curSpeed)  * k;
      curMorph  += (targetMorph  - curMorph)  * k;
      curDNoise += (targetDNoise - curDNoise) * k;
      curZoom   += (targetZoom   - curZoom)   * k;

      // Time accumulates with the smoothed speed, not the raw prop.
      uniforms.time.value += curSpeed / 10000;
      uniforms.morph.value = curMorph;
      uniforms.dnoise.value = curDNoise;
      camera.position.z = curZoom;
      uniforms.RGBr.value = p.chromaRGBr / 10;
      uniforms.RGBg.value = p.chromaRGBg / 10;
      uniforms.RGBb.value = p.chromaRGBb / 10;
      uniforms.RGBn.value = p.chromaRGBn / 100;
      uniforms.RGBm.value = p.chromaRGBm;
      uniforms.psize.value = p.spherePsize;
      uniforms.baseColor.value.set(p.baseColor[0], p.baseColor[1], p.baseColor[2]);
      uniforms.rimStrength.value = p.rimStrength;
      uniforms.rimColor.value.set(p.rimColor[0], p.rimColor[1], p.rimColor[2]);
      uniforms.lightningStrength.value = p.lightningStrength;
      uniforms.specStrength.value = p.specStrength;

      // Pointer follow — read ref each frame, smooth toward target. dt-based
      // so it stays consistent across frame rates.
      const ptr = p.pointerRef?.current ?? null;
      const kPtr = 1 - Math.exp(-dt * 14);
      const targetX = ptr ? ptr.x : 0;
      const targetY = ptr ? ptr.y : 0;
      uniforms.uPointer.value.x += (targetX - uniforms.uPointer.value.x) * kPtr;
      uniforms.uPointer.value.y += (targetY - uniforms.uPointer.value.y) * kPtr;
      const targetActive = ptr ? 1 : 0;
      const kAct = 1 - Math.exp(-dt * 7);
      uniforms.uPointerActive.value +=
        (targetActive - uniforms.uPointerActive.value) * kAct;

      mesh.rotation.y += p.cameraSpeedY / 100;
      mesh.rotation.z += p.cameraSpeedX / 100;
      point.rotation.y = mesh.rotation.y;
      point.rotation.z = mesh.rotation.z;

      material.wireframe = p.sphereWireframe;
      mesh.visible = !p.spherePoints;
      point.visible = p.spherePoints;

      camera.lookAt(scene.position);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", handleResize);

    // Observe the container too — Tauri windows resize without firing
    // window-level resize events when the parent layout shifts.
    const ro = new ResizeObserver(handleResize);
    ro.observe(mount);

    return () => {
      window.removeEventListener("resize", handleResize);
      ro.disconnect();
      cancelAnimationFrame(raf);
      try {
        if (renderer.domElement.parentNode === mount) {
          mount.removeChild(renderer.domElement);
        }
      } catch {
        // ignore — DOM may already be torn down by React on unmount
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  // Camera zoom is now smoothed inside the animate loop (so it can fold in
  // the live `level` boost). The GSAP-on-prop-change path was removed to
  // avoid two competing easings on the same property.

  return (
    <div
      ref={mountRef}
      className={props.className}
      style={{ width: "100%", height: "100%", ...props.style }}
    />
  );
}

// ─── Shaders (Perlin 3D) ─────────────────────────────────────────────────────

const NOISE_FNS = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

  float cnoise(vec3 P) {
    vec3 Pi0 = floor(P);
    vec3 Pi1 = Pi0 + vec3(1.0);
    Pi0 = mod289(Pi0);
    Pi1 = mod289(Pi1);
    vec3 Pf0 = fract(P);
    vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz;
    vec4 iz1 = Pi1.zzzz;
    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0);
    vec4 ixy1 = permute(ixy + iz1);
    vec4 gx0 = ixy0 * (1.0 / 7.0);
    vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5);
    gy0 -= sz0 * (step(0.0, gy0) - 0.5);
    vec4 gx1 = ixy1 * (1.0 / 7.0);
    vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5);
    gy1 -= sz1 * (step(0.0, gy1) - 0.5);
    vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
    vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
    vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
    vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
    vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
    vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
    vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
    vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
    vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);
    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
  }
`;

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  uniform float time;
  uniform float morph;
  uniform float psize;
  uniform vec2  uPointer;
  uniform float uPointerActive;
  ${NOISE_FNS}
  void main() {
    // Base perlin morph — same as upstream.
    float f = morph * cnoise(normal + time);

    // Pointer-driven directional bulge. Treat the pointer as a 3D pull
    // direction in front of the camera; vertices whose normals face that
    // direction get pushed outward, so the side of the orb closest to the
    // cursor swells like soft jelly. Falls back to zero when uPointerActive
    // is 0, so the effect smoothly fades in / out as you enter / leave.
    vec3 pullDir = normalize(vec3(uPointer.x, -uPointer.y, 0.55));
    float pullFacing = max(dot(normalize(normal), pullDir), 0.0);
    float pull = pow(pullFacing, 1.8) * uPointerActive * 4.5;

    vNormal = normalize(normal);
    vec4 pos = vec4(position + (f + pull) * normal, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * pos;
    gl_PointSize = psize;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vNormal;
  uniform float time;
  uniform float RGBr;
  uniform float RGBg;
  uniform float RGBb;
  uniform float RGBn;
  uniform float RGBm;
  uniform float dnoise;
  uniform vec3  baseColor;
  uniform float rimStrength;       // 0..1+ — fresnel rim glow intensity
  uniform vec3  rimColor;          // colour added at the rim
  uniform float lightningStrength; // 0..1+ — gated high-freq noise bright streaks
  uniform float specStrength;      // 0..1+ — moving pinpoint specular
  uniform vec2  uPointer;          // [-1..1] pointer position (ref-driven)
  uniform float uPointerActive;    // 0..1 hover activeness (smoothed)
  ${NOISE_FNS}
  void main() {
    float r = cnoise(RGBr * (vNormal + time));
    float g = cnoise(RGBg * (vNormal + time));
    float b = cnoise(RGBb * (vNormal + time));
    float n = 50.0 * cnoise((RGBn) * (vNormal)) * cnoise(RGBm * (vNormal + time));
    n -= 0.10 * cnoise(dnoise * vNormal);
    // Floor the noise at zero so negative cnoise values don't drop pixels to
    // pure black; add baseColor on top so the orb's dim regions tint to a
    // luminous purple/blue/pink instead of dying. baseColor=(0,0,0) reverts
    // to the upstream behaviour for back-compat.
    vec3 noiseColor = max(vec3(r + n, g + n, b + n), 0.0);
    vec3 color = baseColor + noiseColor;

    // ── In-shader effects (move/morph with the orb) ───────────────────────
    // The mesh's vertex normal (vNormal) tilts with the morph, so everything
    // computed here breathes with the surface — the rim, the streaks, and the
    // specular all wobble in lock-step with the noise displacement.
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    float facing = clamp(dot(vNormal, viewDir), 0.0, 1.0);

    // Fresnel rim — brightens edges where the surface turns away from the
    // camera. Tighter exponent = a thinner glowing rim instead of a wash.
    float fresnel = pow(1.0 - facing, 3.0);
    color += rimColor * fresnel * rimStrength;

    // Animated lightning — high-frequency cnoise gated to the top crests
    // shows up as bright moving streaks crawling over the surface.
    float lightning = cnoise((vNormal + time * 1.6) * 7.5);
    lightning = max(lightning - 0.45, 0.0) * 2.4;
    color += vec3(0.95, 0.88, 1.0) * lightning * lightningStrength;

    // Moving specular pinpoint — a virtual light orbiting the orb. Sharp
    // exponent gives a small glassy highlight that drifts as 'time' advances.
    vec3 lightDir = normalize(vec3(
      sin(time * 0.55) * 0.65,
      0.45,
      cos(time * 0.55) * 0.45 + 0.65
    ));
    float spec = pow(max(dot(vNormal, lightDir), 0.0), 28.0);
    color += vec3(1.0, 0.95, 1.0) * spec * specStrength;

    // Subtle inner-glow lift toward the centre — gives the orb a "lit from
    // within" feel without darkening the rim. Driven by 'facing' so it
    // peaks at the part of the surface aimed at the camera and falls off
    // gracefully toward the silhouette.
    color += vec3(0.10, 0.08, 0.14) * facing;

    // Pointer-following bright spot — the surface area facing the cursor
    // brightens, like a flashlight tracking across the orb. Pairs with the
    // vertex bulge so the same region both swells AND lights up.
    vec3 pullDir = normalize(vec3(uPointer.x, -uPointer.y, 0.55));
    float pointerFacing = max(dot(vNormal, pullDir), 0.0);
    float ptrHi = pow(pointerFacing, 4.0) * uPointerActive;
    color += vec3(0.85, 0.95, 1.0) * ptrHi * 0.55;

    gl_FragColor = vec4(color, 1.0);
  }
`;
