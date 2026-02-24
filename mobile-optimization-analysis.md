# Mobile Performance Optimization Analysis — AnatomyLens

## Context

The app is a React + Three.js (r3f) 3D anatomy viewer that renders a 6.3 MB GLB with hundreds of individually interactive meshes, bilateral mirroring, per-structure animated materials, and a full PBR lighting pipeline. The `useIsMobile()` hook already exists and is ready to use.

---

## Easy Wins (Low Risk, High Impact)

These are changes to `AnatomyCanvas.tsx` and `AnatomyModelGLTF.tsx` that are 1–5 line changes with minimal downstream risk.

### 1. Cap the Device Pixel Ratio (DPR) — Biggest Bang for Buck

**File:** `AnatomyCanvas.tsx`
**Current:** Canvas renders at the device's native DPR (mobile = 2×–3×, meaning 4–9× the pixel fill rate of desktop 1×).
**Fix:** Add `dpr={[1, 1.5]}` to the `<Canvas>` (or `dpr={isMobile ? 1 : [1, 2]}`).

```tsx
<Canvas
  dpr={isMobile ? 1 : [1, 2]}
  // ...rest unchanged
>
```

This is probably the single highest-impact change for mobile GPU performance and battery life. A Retina mobile screen at DPR 3 means the scene is rendered at 3× width × 3× height = 9× the pixels. Capping to 1 cuts that to baseline.

---

### 2. Disable Antialiasing on Mobile

**File:** `AnatomyCanvas.tsx`
**Current:** `antialias: true` always.
**Fix:**

```tsx
gl={{
  antialias: !isMobile,
  // ...
}}
```

MSAA antialiasing requires 4–8 extra samples per pixel and is genuinely expensive on mobile tile-based GPUs. Combined with the DPR cap above, the visual difference on small screens is minimal.

---

### 3. Disable / Reduce Shadow Maps on Mobile

**File:** `AnatomyCanvas.tsx`
**Current:** `shadows` enabled on Canvas, directional light has `castShadow` with `shadow-mapSize={[1024, 1024]}`.
**Fix:** Disable `shadows` prop on Canvas when mobile, or at minimum drop the shadow map size to `[512, 512]`.

```tsx
<Canvas shadows={!isMobile} ...>
  <directionalLight
    castShadow={!isMobile}
    shadow-mapSize={isMobile ? [512, 512] : [1024, 1024]}
    ...
  />
```

Shadow maps require a full depth-pass render of the scene each frame, effectively doubling the render work.

---

### 4. Remove ContactShadows on Mobile

**File:** `AnatomyCanvas.tsx`
**Current:** `<ContactShadows>` renders unconditionally.
**Fix:**

```tsx
{!isMobile && (
  <ContactShadows position={[0, -0.5, 0]} opacity={0.4} scale={10} blur={2} far={4} />
)}
```

`ContactShadows` from drei performs an extra render pass internally. It's a cosmetic effect that's not visible on small screens anyway.

---

### 5. Skip HDR Environment on Mobile

**File:** `AnatomyCanvas.tsx`
**Current:** `<Environment preset="studio" />` always.
**Fix:** Conditionally render, or replace with a simple hemisphere light on mobile.

```tsx
{isMobile
  ? <hemisphereLight intensity={0.3} />
  : <Environment preset="studio" />
}
```

The studio HDR preset loads a texture and contributes to the PBR lighting calculation on every reflective surface. On mobile with simpler materials (see #7 below), this provides zero visible benefit.

---

## Medium Wins (1–File Changes, Slightly More Involved)

### 6. Fix Per-Frame `new THREE.Color()` Allocation (All Devices, Critical on Mobile)

**File:** `AnatomyModelGLTF.tsx`, `StructureMesh` component
**Current:** In `useFrame`, every structure calls:

```ts
material.color.lerp(new THREE.Color(targetColor), 0.1);
```

With potentially 100+ structures rendered, this allocates 100+ `THREE.Color` objects **every single frame** (60 fps = thousands of GC objects per second). This is a real source of jank on mobile GCs.
**Fix:** Cache a `THREE.Color` instance in a `useRef` and use `.set()` to reuse it:

```ts
const tempColor = useRef(new THREE.Color());
// In useFrame:
tempColor.current.set(targetColor);
material.color.lerp(tempColor.current, 0.1);
```

This is a correctness fix that helps all devices, but mobile JS engines and GCs are much more sensitive to allocation pressure.

---

### 7. Use `MeshLambertMaterial` on Mobile

**File:** `AnatomyModelGLTF.tsx`, `StructureMesh.material` useMemo
**Current:** Every structure uses `THREE.MeshStandardMaterial` (full PBR — environment maps, roughness, metalness).
**Fix:** On mobile, substitute `THREE.MeshLambertMaterial`, which skips all PBR lighting calculations and the environment probe.

```ts
const material = useMemo(() => {
  if (isMobile) {
    return new THREE.MeshLambertMaterial({
      color: colors.default,
      transparent: true,
      opacity: metadata.type === 'bone' ? 1 : 0.9,
      side: THREE.FrontSide,  // also drop DoubleSide
    });
  }
  return new THREE.MeshStandardMaterial({ ... });
}, [colors.default, metadata.type, isMobile]);
```

The anatomy model doesn't rely on reflections or glossy materials — it's flat anatomical color-coding. Lambert will look nearly identical. The `THREE.FrontSide` change (dropping `DoubleSide`) halves the fragment work too.

---

### 8. Zoom-Based Layer Auto-Hiding on Mobile

**File:** `AnatomyModelGLTF.tsx` / `anatomyStore.ts`
**Current:** `zoomLevel` is already tracked in the store (0–1, higher = more zoomed in), but it's not used to cull draw calls.
**Fix:** On mobile at low zoom, auto-hide small/thin structures (tendons, ligaments, fascia) since they're invisible at that scale anyway. This reduces draw calls without user-visible impact.

```ts
// In StructureMesh, alongside the existing isTypeVisible check:
const isZoomCulled = isMobile &&
  zoomLevel < 0.35 &&
  ['tendon', 'ligament', 'fascia', 'bursa', 'capsule', 'membrane'].includes(metadata.type);

if (!isTypeVisible || isZoomCulled) return null;
```

This ties into the "render different details based on zoom level" idea already discussed — it's a lightweight version that doesn't require LOD mesh assets.

---

## More Involved (Architectural Changes)

### 9. `frameloop="demand"` (Conditional Rendering)

**File:** `AnatomyCanvas.tsx`
Currently the canvas renders at 60fps continuously even when nothing moves (user is idle, no animation running). `frameloop="demand"` makes r3f only render when explicitly told to (`invalidate()`).

The challenge: the `useFrame` animation loop (opacity/color lerping in each `StructureMesh`) runs continuously until it converges. To implement demand rendering, the lerp animation would need to be driven off a timer or state change that fires `invalidate()` until convergence, then stops. This is workable but requires refactoring the animation pattern.

**Payoff:** Potentially the biggest battery/thermal win on mobile — idle states cost nothing.

---

### 10. LOD Mesh (Lower-Poly Model for Mobile)

**Files:** `AnatomyModelGLTF.tsx`, asset pipeline
This is the "lower-detail mesh for smaller screens" idea. Would require:
- Generating a decimated version of `body.glb` (e.g., with Blender or `meshoptimizer`)
- Conditionally loading `/models/body-mobile.glb` vs `/models/body.glb` based on `isMobile`
- Using `useGLTF.preload` conditionally

The r3f/drei `<Lod>` component (from `@react-three/drei`) could handle zoom-based switching once both assets exist. The metadata matching logic in `AnatomyModelGLTF.tsx` would need to work with both mesh sets — likely fine if mesh names are preserved.

---

## Recommended Implementation Order

1. **DPR cap** — 1 line, huge impact, do it first
2. **Disable antialiasing on mobile** — 1 line
3. **Disable shadows / ContactShadows on mobile** — 3 lines
4. **Fix `new THREE.Color()` in useFrame** — small refactor, fixes all devices
5. **Skip Environment preset on mobile** — 3 lines
6. **Zoom-based layer culling on mobile** — ~10 lines in StructureMesh
7. **MeshLambertMaterial on mobile** — medium refactor, good visual/perf tradeoff
8. **frameloop="demand"** — architectural refactor
9. **LOD mesh** — requires asset work
