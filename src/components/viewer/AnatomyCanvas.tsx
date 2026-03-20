import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows } from '@react-three/drei';
import { useAnatomyStore } from '@/store';
import { useIsMobile } from '@/hooks';
import { AnatomyModelGLTF } from './AnatomyModelGLTF';
import { LoadingIndicator } from './LoadingIndicator';
import { CanvasErrorBoundary } from '../ui/CanvasErrorBoundary';

/**
 * Main 3D canvas component for the anatomy viewer.
 * Sets up the Three.js scene with proper lighting, controls, and environment.
 * Wrapped in error boundary to prevent white-screen crashes.
 */
export function AnatomyCanvas() {
  const setZoomLevel = useAnatomyStore((state) => state.setZoomLevel);
  const isMobile = useIsMobile();

  return (
    <CanvasErrorBoundary>
      <Canvas
        // cap pixel rate on mobile for performance
        dpr={isMobile ? 1 : [1, 2]}
        camera={{
          position: [0, 0, 2.5],
          fov: 50,
          near: 0.1,
          far: 100,
        }}
        shadows
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: 'high-performance',
        }}
        style={{
          background: 'transparent',
          touchAction: 'none', // Prevent touch scrolling
        }}
        // Handle WebGL context loss gracefully
        onCreated={({ gl }) => {
          const canvas = gl.domElement;

          canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            console.warn('[AnatomyCanvas] WebGL context lost');
          });

          canvas.addEventListener('webglcontextrestored', () => {
            console.log('[AnatomyCanvas] WebGL context restored');
          });
        }}
      >
        {/* Lighting */}
        <ambientLight intensity={0.4} />
        <directionalLight
          position={[5, 5, 5]}
          intensity={1}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight
          position={[-5, 3, -5]}
          intensity={0.5}
        />

        {/* Environment for reflections (subtle) */}
        <Environment preset="studio" />

        {/* Ground shadow */}
        <ContactShadows
          position={[0, -0.5, 0]}
          opacity={0.4}
          scale={10}
          blur={2}
          far={4}
        />

        {/* Main content with loading fallback */}
        <Suspense fallback={<LoadingIndicator />}>
          <AnatomyModelGLTF />
        </Suspense>

        {/* Camera controls */}
        <OrbitControls
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          minDistance={0.3}
          maxDistance={5}
          minPolarAngle={Math.PI * 0.1}
          maxPolarAngle={Math.PI * 0.9}
          // Track zoom level for layer visibility
          onChange={(e) => {
            if (e?.target) {
              const distance = e.target.getDistance();
              // Normalize zoom: closer = higher zoom level
              const normalizedZoom = Math.max(0, Math.min(1, (3 - distance) / 2.5));
              setZoomLevel(normalizedZoom);
            }
          }}
        />
      </Canvas>
    </CanvasErrorBoundary>
  );
}