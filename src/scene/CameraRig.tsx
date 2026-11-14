// The camera: orbit, pan and zoom by hand, and smooth flights when a table
// is clicked or searched, or when the agent points at part of the schema.

import { CameraControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { MathUtils, type PerspectiveCamera } from 'three';
import { bounds } from '../layout/force';
import { positionsOf, useScene } from '../state/scene';

/** The direction the camera looks from: in front of the faces, a little above and to the side. */
const VIEW = { x: 0.22, y: 0.38, z: 1 };
/** One table is looked at from higher up, over the tables in front of it. */
const VIEW_ONE = { x: 0.2, y: 0.58, z: 1 };

export function CameraRig({ still }: { still: boolean }) {
  const controls = useRef<CameraControls>(null);
  const cmd = useScene((s) => s.camera);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const first = useRef(true);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const s = useScene.getState();
    const names = cmd.tables?.length ? cmd.tables : s.schema.tables.map((t) => t.name);
    const { center, radius } = bounds(positionsOf(s), names, cmd.extra);
    // the narrower of the two view angles decides how far back the camera must be (portrait phones)
    const half = Math.atan(Math.tan(MathUtils.degToRad(camera.fov / 2)) * Math.min(1, size.width / size.height));
    const single = names.length === 1 && !cmd.extra?.length;
    const portrait = size.width < size.height;
    const dist = Math.max(16, (radius * (single ? 2.1 : portrait ? 1 : 0.8)) / Math.sin(half));
    // on a phone the table details cover the lower part of the scene: the table is shown above them
    void c.setFocalOffset(0, single && portrait ? dist * 0.2 : 0, 0, !first.current && !still);
    const VIEW_NOW = single ? VIEW_ONE : VIEW;
    const k = dist / Math.hypot(VIEW_NOW.x, VIEW_NOW.y, VIEW_NOW.z);
    void c.setLookAt(center[0] + VIEW_NOW.x * k, center[1] + VIEW_NOW.y * k, center[2] + VIEW_NOW.z * k, center[0], center[1], center[2], !first.current && !still);
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd.nonce]);

  return <CameraControls ref={controls} makeDefault smoothTime={0.55} minDistance={4} maxDistance={220} maxPolarAngle={Math.PI * 0.62} dollySpeed={0.6} />;
}
