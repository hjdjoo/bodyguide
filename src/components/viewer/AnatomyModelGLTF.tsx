import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useAnatomyStore } from '@/store';
import type { LayerVisibility } from '@/types';

// Import the metadata
import bodyMetadata from '@/data/body_metadata.json' with {type: "json"};

// ============================================================
// DEBUG CONFIGURATION
// ============================================================

const DEBUG_ENABLED = true;
const DEBUG_STRUCTURES = ["__"];

function debugLog(meshName: string, message: string, data?: unknown) {
  if (!DEBUG_ENABLED) return;
  if (!DEBUG_STRUCTURES.some(s => meshName.toLowerCase().includes(s.toLowerCase()))) return;
  console.log(`[DEBUG ${meshName}] ${message}`, data ?? '');
}

debugLog("test call", "test call");

// ============================================================
// TYPES
// ============================================================

export interface StructureMetadata {
  meshId: string;
  originalName: string;
  baseName: string;
  type: 'bone' | 'muscle' | 'organ' | 'tendon' | 'ligament' | 'cartilage' | 'fascia' | 'bursa' | 'capsule' | 'membrane' | 'other';
  layer: number;
  region: string;
  bilateral: boolean;
  center: [number, number, number];
  mirroredCenter?: [number, number, number];
}

export interface MetadataFile {
  version: string;
  source: string;
  region: string;
  export_notes: string;
  bilateral_count: number;
  midline_count: number;
  structures: Record<string, StructureMetadata>;
}

interface ProcessedStructure {
  uniqueKey: string;
  geometry: THREE.BufferGeometry;
  worldMatrix: THREE.Matrix4;
  metadata: StructureMetadata;
  center: THREE.Vector3;
  mirroredCenter?: THREE.Vector3;
}

// ============================================================
// CONSTANTS
// ============================================================

const TYPE_COLORS: Record<string, { default: string; highlight: string }> = {
  bone: { default: '#E8DCC4', highlight: '#FFF8E7' },
  muscle: { default: '#C41E3A', highlight: '#FF4D6A' },
  organ: { default: '#8B4557', highlight: '#A85A6F' },
  tendon: { default: '#D4A574', highlight: '#E8C9A0' },
  ligament: { default: '#8B7355', highlight: '#A89070' },
  cartilage: { default: '#A8D5BA', highlight: '#C5E8D2' },
  fascia: { default: '#D4A5A5', highlight: '#E8C5C5' },
  bursa: { default: '#B8A090', highlight: '#D0C0B0' },
  capsule: { default: '#9090A8', highlight: '#B0B0C8' },
  membrane: { default: '#A0B8A0', highlight: '#C0D8C0' },
  other: { default: '#888888', highlight: '#AAAAAA' },
};

const TYPE_TO_VISIBILITY_KEY: Record<string, keyof LayerVisibility> = {
  bone: 'bones',
  muscle: 'muscles',
  organ: 'organs',
  tendon: 'tendons',
  ligament: 'ligaments',
  cartilage: 'bones',
  fascia: 'muscles',
  bursa: 'ligaments',
  capsule: 'ligaments',
  membrane: 'ligaments',
  other: 'muscles',
};

// Double-click timing threshold (ms)
const DOUBLE_CLICK_THRESHOLD = 300;

// ============================================================
// STRUCTURE FILTERING
// ============================================================

const EXCLUDE_SUFFIX_PATTERNS = [
  /_j$/i,
  /_i$/i,
  /_o\d*[lr]$/i,
  /_e\d+[lr]$/i,
  /_el$/i,
  /_er$/i,
];

const EXCLUDE_TYPES = ['organ'];

function shouldRenderByTypeAndName(metadata: StructureMetadata): boolean {
  if (EXCLUDE_TYPES.includes(metadata.type)) {
    return false;
  }
  if (EXCLUDE_SUFFIX_PATTERNS.some(pattern => pattern.test(metadata.meshId))) {
    return false;
  }
  return true;
}

// ============================================================
// MESH MATCHING - SIMPLIFIED FOR V11
// ============================================================
function normalizeGltfNameToBase(gltfName: string): string {
  const normalized = gltfName
    .replace(/00\d+(_\d+)?/g, '')
    .replace(/_\d+$/g, '')
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/_[lr]$/i, '')
    .replace(/__+/g, '_')
    .replace(/_+$/, '')
    .replace(/\.+$/, '')
    .replace(/-/, '_');

  const abnormalSuffixes = ["nel", "ner", "andr", "andl", "usr", "usl"];
  if (abnormalSuffixes.some(suffix => normalized.endsWith(suffix))) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Match a glTF mesh to its metadata.
 * V11 simplification: mesh names in GLB should exactly match metadata keys.
 */
function findMetadataForMesh(
  meshName: string,
  structures: Record<string, StructureMetadata>
): StructureMetadata | null {
  // Direct match (most common case in V11)
  if (structures[meshName]) {
    return structures[meshName];
  }

  // Lowercase fallback
  const lowered = meshName.toLowerCase();
  if (structures[lowered]) {
    return structures[lowered];
  }

  const normalized = normalizeGltfNameToBase(meshName);
  if (structures[normalized]) {
    return structures[normalized]
  }

  // Try without numeric suffix (e.g., "mesh_name_1" -> "mesh_name")
  const withoutSuffix = meshName.replace(/_\d+$/, '');
  if (structures[withoutSuffix]) {
    return structures[withoutSuffix];
  }

  return null;
}

// ============================================================
// MESH PROCESSING
// ============================================================

let hasLoggedMemoryStrategy = false;

function processGLTFMesh(
  child: THREE.Mesh,
  metadata: StructureMetadata,
  uniqueKey: string
): ProcessedStructure {
  if (!hasLoggedMemoryStrategy) {
    hasLoggedMemoryStrategy = true;
    console.log('[MEMORY] ✔ Using direct geometry references (no cloning)');
    console.log('[MEMORY] ✔ Bilateral structures mirrored at runtime');
  }

  const worldMatrix = child.matrixWorld.clone();
  const center = new THREE.Vector3(...metadata.center);

  // For bilateral structures, also store the mirrored center
  const mirroredCenter = metadata.bilateral && metadata.mirroredCenter
    ? new THREE.Vector3(...metadata.mirroredCenter)
    : undefined;

  return {
    uniqueKey,
    geometry: child.geometry,
    worldMatrix,
    metadata,
    center,
    mirroredCenter,
  };
}

// ============================================================
// SINGLE MESH INSTANCE COMPONENT
// ============================================================

interface MeshInstanceProps {
  geometry: THREE.BufferGeometry;
  worldMatrix: THREE.Matrix4;
  metadata: StructureMetadata;
  isMirrored: boolean;
  material: THREE.MeshStandardMaterial;
  onPointerOver: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: (e: ThreeEvent<PointerEvent>) => void;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  isInteractive: boolean;
}

function MeshInstance({
  geometry,
  worldMatrix,
  isMirrored,
  material,
  onPointerOver,
  onPointerOut,
  onClick,
  isInteractive,
}: MeshInstanceProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.matrixAutoUpdate = false;

      if (isMirrored) {
        // Create mirrored matrix: flip X axis
        const mirrorMatrix = worldMatrix.clone();
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        mirrorMatrix.decompose(position, quaternion, scale);

        // Mirror position across X=0
        position.x = -position.x;

        // Mirror the rotation (flip X scale to mirror geometry)
        scale.x = -scale.x;

        mirrorMatrix.compose(position, quaternion, scale);
        meshRef.current.matrix.copy(mirrorMatrix);
      } else {
        meshRef.current.matrix.copy(worldMatrix);
      }

      meshRef.current.matrixWorldNeedsUpdate = true;
    }
  }, [worldMatrix, isMirrored]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      matrixAutoUpdate={false}
      onPointerOver={isInteractive ? onPointerOver : undefined}
      onPointerOut={isInteractive ? onPointerOut : undefined}
      onClick={isInteractive ? onClick : undefined}
    />
  );
}

// ============================================================
// STRUCTURE MESH COMPONENT (handles bilateral rendering)
// ============================================================

interface StructureMeshProps {
  structure: ProcessedStructure;
}

function StructureMesh({ structure }: StructureMeshProps) {
  const { geometry, worldMatrix, metadata } = structure;
  const [hovered, setHovered] = useState(false);
  const animatedOpacity = useRef(1);
  // Reusable Color instance to avoid per-frame heap allocations inside useFrame.
  // Allocating `new THREE.Color()` on every frame × every structure creates
  // significant GC pressure, especially on mobile JS engines.
  const tempColor = useRef(new THREE.Color());

  // Deferred selection pattern refs
  const pendingSelectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCount = useRef(0);

  const {
    hoveredStructureId,
    selectedStructureId,
    setHoveredStructure,
    setSelectedStructure,
    layerVisibility,
    peelDepth,
    searchQuery,
    searchIsolationMode,
    manuallyPeeledIds,
    toggleManualPeel,
  } = useAnatomyStore();

  const colors = TYPE_COLORS[metadata.type] || TYPE_COLORS.muscle;
  const isSelected = selectedStructureId === metadata.meshId;
  const isManuallyPeeled = manuallyPeeledIds.has(metadata.meshId);

  // Search matching - check both meshId and original name
  const matchesSearch = searchQuery.length > 1 && (
    metadata.meshId.toLowerCase().includes(searchQuery.toLowerCase()) ||
    metadata.originalName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    metadata.baseName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isHighlighted = hovered || isSelected || hoveredStructureId === metadata.meshId || matchesSearch;

  const visibilityKey = TYPE_TO_VISIBILITY_KEY[metadata.type] || 'muscles';
  const isTypeVisible = layerVisibility[visibilityKey];

  const isBoneType = metadata.type === 'bone' || metadata.type === 'cartilage';
  const isSearchActive = searchQuery.length > 1;
  const isHiddenByIsolation = isSearchActive && searchIsolationMode && !matchesSearch && !isBoneType;

  const maxVisibleLayer = 3 - peelDepth;
  const isLayerPeeled = metadata.layer > maxVisibleLayer;

  const shouldPeel = (isLayerPeeled || isManuallyPeeled || isHiddenByIsolation) && !matchesSearch;
  const targetOpacity = shouldPeel ? 0 : (metadata.type === 'bone' ? 1 : 0.9);

  // Create material (shared between both sides for bilateral)
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: colors.default,
      roughness: 0.6,
      metalness: 0.1,
      transparent: true,
      opacity: metadata.type === 'bone' ? 1 : 0.9,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
  }, [colors.default, metadata.type]);

  // Cleanup pending timer on unmount
  useEffect(() => {
    return () => {
      if (pendingSelectionTimer.current) {
        clearTimeout(pendingSelectionTimer.current);
      }
    };
  }, []);

  // Animation frame updates
  useFrame(() => {
    let targetColor = colors.default;
    if (matchesSearch) {
      targetColor = '#FFD700';
    } else if (isHighlighted && !shouldPeel) {
      targetColor = colors.highlight;
    }
    tempColor.current.set(targetColor);
    material.color.lerp(tempColor.current, 0.1);

    animatedOpacity.current += (targetOpacity - animatedOpacity.current) * 0.08;
    material.opacity = animatedOpacity.current;
    material.depthWrite = animatedOpacity.current > 0.5;
  });


  const isInteractive = !shouldPeel;

  // Event handlers (shared for both sides)
  const handlePointerOver = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    setHoveredStructure(metadata.meshId);
    document.body.style.cursor = 'pointer';
  }, [metadata.meshId, setHoveredStructure]);

  const handlePointerOut = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(false);
    setHoveredStructure(null);
    document.body.style.cursor = 'auto';
  }, [setHoveredStructure]);

  /**
   * Deferred selection click handler.
   * 
   * Instead of immediately selecting on first click (which opens InfoPanel
   * and blocks the second click on mobile), we defer the selection:
   * 
   * 1. First click: Start a timer, increment click count
   * 2. Second click within threshold: Cancel timer, execute peel
   * 3. Timer expires: Execute the deferred selection
   * 
   * This ensures double-click/tap works even when InfoPanel would normally
   * render an overlay that intercepts the second tap.
   */
  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();

    clickCount.current += 1;
    const currentClickCount = clickCount.current;

    if (currentClickCount === 1) {
      // First click: start deferred selection timer
      pendingSelectionTimer.current = setTimeout(() => {
        // Timer fired without second click - this is a single click
        if (clickCount.current === 1) {
          // Execute selection (opens InfoPanel)
          setSelectedStructure(isSelected ? null : metadata.meshId);
        }
        // Reset click count
        clickCount.current = 0;
        pendingSelectionTimer.current = null;
      }, DOUBLE_CLICK_THRESHOLD);
    } else if (currentClickCount === 2) {
      // Second click within threshold - this is a double click
      // Cancel the pending selection
      if (pendingSelectionTimer.current) {
        clearTimeout(pendingSelectionTimer.current);
        pendingSelectionTimer.current = null;
      }

      // Execute peel action
      toggleManualPeel(metadata.meshId);

      // Clear selection if any (don't open InfoPanel on double-click)
      setSelectedStructure(null);

      // Reset click count
      clickCount.current = 0;
    }
  }, [isSelected, metadata.meshId, setSelectedStructure, toggleManualPeel]);


  // Early return if type not visible
  if (!isTypeVisible) return null;
  // Render one or two instances depending on bilateral flag
  return (
    <>
      {/* Primary (left) side */}
      <MeshInstance
        geometry={geometry}
        worldMatrix={worldMatrix}
        metadata={metadata}
        isMirrored={false}
        material={material}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
        isInteractive={isInteractive}
      />

      {/* Mirrored (right) side for bilateral structures */}
      {metadata.bilateral && (
        <MeshInstance
          geometry={geometry}
          worldMatrix={worldMatrix}
          metadata={metadata}
          isMirrored={true}
          material={material}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onClick={handleClick}
          isInteractive={isInteractive}
        />
      )}
    </>
  );
}

// ============================================================
// MAIN ANATOMY MODEL COMPONENT
// ============================================================

export function AnatomyModelGLTF() {
  const { scene } = useGLTF('/models/body.glb');
  const clearSelection = useAnatomyStore((state) => state.clearSelection);
  const setLoading = useAnatomyStore((state) => state.setLoading);

  const metadata = JSON.parse(JSON.stringify(bodyMetadata)) as MetadataFile;

  const processedStructures = useMemo(() => {
    const structures: ProcessedStructure[] = [];
    const processedMeshUuids = new Set<string>();
    let skippedByTypeOrName = 0;
    let skippedDuplicate = 0;
    let unmatchedCount = 0;
    let bilateralCount = 0;

    scene.updateMatrixWorld(true);

    if (DEBUG_ENABLED) {
      console.log('='.repeat(60));
      console.log('[DEBUG] Processing anatomy model (V11 - Bilateral Mirroring)...');
      console.log(`[DEBUG] Metadata has ${Object.keys(metadata.structures).length} structures`);
      console.log('='.repeat(60));
    }

    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const gltfMeshName = child.name;

        if (processedMeshUuids.has(child.uuid)) {
          skippedDuplicate++;
          return;
        }

        const structureData = findMetadataForMesh(gltfMeshName, metadata.structures);

        if (!structureData) {
          if (DEBUG_ENABLED) {
            console.log(`No match for mesh: ${gltfMeshName}`);
          }
          unmatchedCount++;
          return;
        }

        if (!shouldRenderByTypeAndName(structureData)) {
          skippedByTypeOrName++;
          return;
        }

        processedMeshUuids.add(child.uuid);

        const processed = processGLTFMesh(child, structureData, child.uuid);
        structures.push(processed);

        if (structureData.bilateral) {
          bilateralCount++;
        }
      }
    });

    console.log(`Loaded ${structures.length} unique meshes`);
    console.log(`  Bilateral: ${bilateralCount} (renders as ${bilateralCount * 2} instances)`);
    console.log(`  Total visual structures: ${structures.length + bilateralCount}`);
    console.log(`  Skipped: ${skippedByTypeOrName} (filtered), ${skippedDuplicate} (duplicate), ${unmatchedCount} (no metadata)`);

    return structures;
  }, [scene, metadata]);

  useEffect(() => {
    setLoading(false);
  }, [setLoading]);

  // Calculate model bounds (accounting for bilateral mirroring)
  const modelCenter = useMemo(() => {
    if (processedStructures.length === 0) {
      return new THREE.Vector3();
    }

    const box = new THREE.Box3();
    const tempMesh = new THREE.Mesh();

    processedStructures.forEach(({ geometry, worldMatrix, metadata }) => {
      // Add primary side
      tempMesh.geometry = geometry;
      tempMesh.matrixAutoUpdate = false;
      tempMesh.matrix.copy(worldMatrix);
      tempMesh.updateMatrixWorld(true);

      const meshBox = new THREE.Box3().setFromObject(tempMesh);
      box.union(meshBox);

      // For bilateral, also account for mirrored side
      if (metadata.bilateral) {
        const mirrorMatrix = worldMatrix.clone();
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        mirrorMatrix.decompose(position, quaternion, scale);
        position.x = -position.x;
        scale.x = -scale.x;
        mirrorMatrix.compose(position, quaternion, scale);

        tempMesh.matrix.copy(mirrorMatrix);
        tempMesh.updateMatrixWorld(true);
        const mirroredBox = new THREE.Box3().setFromObject(tempMesh);
        box.union(mirroredBox);
      }
    });

    return box.getCenter(new THREE.Vector3());
  }, [processedStructures]);

  return (
    <group
      position={[-modelCenter.x, -modelCenter.y, -modelCenter.z]}
      onClick={(e) => {
        if (e.eventObject === e.object) {
          clearSelection();
        }
      }}
    >
      {processedStructures.map((structure) => (
        <StructureMesh
          key={structure.uniqueKey}
          structure={structure}
        />
      ))}
    </group>
  );
}

useGLTF.preload('/models/body.glb');