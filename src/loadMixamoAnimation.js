import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

import { mixamoVRMRigMap } from './mixamoVRMRigMap.js';

const DEBUG_MIXAMO = false;
// 0.01 is a good value
const FLOOR_MOTION_DAMPING = 0.01;
const VERTICAL_MOTION_DAMPING = 0.01;

const MAX_FLOOR_TRAVEL_METERS = 2.75;

function getNameVariants(name) {
  const variants = new Set([name]);
  const pipeSegment = name.split('|').pop();
  const colonSegment = name.split(':').pop();

  if (pipeSegment) variants.add(pipeSegment);
  if (colonSegment) variants.add(colonSegment);
  if (pipeSegment?.includes(':')) variants.add(pipeSegment.split(':').pop());

  for (const variant of [...variants]) {
    const normalizedMixamoVariant = variant.replace(/^mixamorig\d+/, 'mixamorig');
    if (normalizedMixamoVariant !== variant) {
      variants.add(normalizedMixamoVariant);
    }
  }

  return [...variants].filter(Boolean);
}

function findObjectByNameVariants(root, name) {
  const variants = getNameVariants(name);

  return (
    root.getObjectByName(name) ??
    root.getObjectByProperty('name', variants.find((variant) => root.getObjectByName(variant)) ?? '') ??
    root.getObjectByProperty(
      'name',
      root
        .getObjectsByProperty('type', 'Bone')
        .map((bone) => bone.name)
        .find((boneName) => variants.some((variant) => boneName === variant || boneName.endsWith(`|${variant}`) || boneName.endsWith(`:${variant}`))) ?? ''
    )
  );
}

function parseTrackBinding(trackName) {
  const propertyMatch = trackName.match(/\.(position|quaternion|scale)$/);

  if (!propertyMatch) {
    return { rigName: trackName, propertyName: '' };
  }

  const propertyName = propertyMatch[1];
  const rigName = trackName.slice(0, -(`.${propertyName}`.length));

  return {
    rigName,
    propertyName
  };
}

function getMixamoBoneInfo(rigName) {
  const variants = getNameVariants(rigName);

  for (const variant of variants) {
    if (mixamoVRMRigMap[variant]) {
      return {
        mixamoRigName: variant,
        vrmBoneName: mixamoVRMRigMap[variant]
      };
    }
  }

  return null;
}

function getMixamoBoneInfoFromTrackName(trackName) {
  const { rigName, propertyName } = parseTrackBinding(trackName);

  if (!propertyName) {
    return null;
  }

  const directMatch = getMixamoBoneInfo(rigName);
  if (directMatch) {
    return {
      ...directMatch,
      propertyName,
      lookupName: rigName
    };
  }

  const bracketMatch = trackName.match(/\[([^\]]+)\]\.(position|quaternion|scale)$/);
  if (bracketMatch) {
    const bracketBone = bracketMatch[1];
    const bracketInfo = getMixamoBoneInfo(bracketBone);

    if (bracketInfo) {
      return {
        ...bracketInfo,
        propertyName: bracketMatch[2],
        lookupName: bracketBone
      };
    }
  }

  const mappedBoneName = Object.keys(mixamoVRMRigMap).find((boneName) => trackName.includes(boneName));
  if (mappedBoneName) {
    return {
      mixamoRigName: mappedBoneName,
      vrmBoneName: mixamoVRMRigMap[mappedBoneName],
      propertyName,
      lookupName: mappedBoneName
    };
  }

  return null;
}

// VRM humanoid finger bones all contain one of these tokens. Mixamo->VRM finger
// retargeting is unreliable (the two skeletons have different finger rest poses,
// so the retargeted absolute rotation plants the fingers in a fixed twisted /
// backward pose), and Mixamo idle finger motion is only a couple of degrees
// anyway. We drop these tracks so fingers stay in the VRM's natural rest pose
// and the gesture layer can pose them cleanly.
const FINGER_BONE_TOKENS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const isFingerVrmBone = (vrmBoneName) =>
  !!vrmBoneName && FINGER_BONE_TOKENS.some((token) => vrmBoneName.includes(token));

export async function loadMixamoAnimation(url, vrm, options = {}) {
  const { allowVerticalMotion = false, allowFloorMotion = false, rootMotionNodeName = null, excludeFingers = true } = options;
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') ?? asset.animations[0];

  if (!clip) {
    throw new Error('No animation clip was found in the selected FBX file.');
  }

  const motionHips =
    findObjectByNameVariants(asset, 'mixamorigHips') ??
    findObjectByNameVariants(asset, 'Hips');
  const vrmHips = vrm.humanoid?.getNormalizedBoneNode('hips');

  if (!motionHips || !vrmHips) {
    throw new Error(
      'Could not find a Mixamo hips bone in this FBX. Try a Mixamo export as FBX Binary, preferably Without Skin.'
    );
  }

  const tracks = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const workingQuaternion = new THREE.Quaternion();
  const workingVector = new THREE.Vector3();
  const motionHipsHeight = motionHips.position.y;
  const vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips.position[1];
  const hipsPositionScale = motionHipsHeight === 0 ? 1 : vrmHipsHeight / motionHipsHeight;
  const debugInfo = {
    clipName: clip.name,
    sourceTrackCount: clip.tracks.length,
    mappedTrackCount: 0,
    skippedTrackCount: 0,
    skippedFingerTrackCount: 0,
    mappedBones: new Set(),
    sampleTracks: clip.tracks.slice(0, 5).map((track) => track.name)
  };

  clip.tracks.forEach((track) => {
    const boneInfo = getMixamoBoneInfoFromTrackName(track.name);

    if (!boneInfo) {
      debugInfo.skippedTrackCount += 1;
      return;
    }

    // Skip finger tracks: their retarget is unreliable and leaves fingers
    // twisted/backward. Fingers are posed by the gesture layer instead.
    if (excludeFingers && isFingerVrmBone(boneInfo.vrmBoneName)) {
      debugInfo.skippedFingerTrackCount = (debugInfo.skippedFingerTrackCount ?? 0) + 1;
      return;
    }

    const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(boneInfo.vrmBoneName)?.name;
    const mixamoRigNode =
      findObjectByNameVariants(asset, boneInfo.lookupName) ??
      findObjectByNameVariants(asset, boneInfo.mixamoRigName);

    if (!vrmNodeName || !mixamoRigNode) {
      debugInfo.skippedTrackCount += 1;
      return;
    }

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();

      for (let i = 0; i < values.length; i += 4) {
        const flatQuaternion = values.slice(i, i + 4);

        workingQuaternion.fromArray(flatQuaternion);
        workingQuaternion.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        workingQuaternion.toArray(flatQuaternion);

        flatQuaternion.forEach((value, index) => {
          values[i + index] = value;
        });
      }

      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${boneInfo.propertyName}`,
          track.times,
          values.map((value, index) => (vrm.meta?.metaVersion === '0' && index % 2 === 0 ? -value : value))
        )
      );
      debugInfo.mappedTrackCount += 1;
      debugInfo.mappedBones.add(boneInfo.mixamoRigName);
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      // Keep Mixamo root motion from launching the avatar out of frame.
      // We preserve vertical bobbing but anchor X/Z movement to the initial pose.
      const firstFrame = track.values.slice(0, 3);
      const values = track.values.slice();

      for (let i = 0; i < values.length; i += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          const sourceValue = values[i + axis];
          const delta = sourceValue - firstFrame[axis];
          const isMeta0FlipAxis = vrm.meta?.metaVersion === '0' && axis !== 1;
          const adjustedDelta = (isMeta0FlipAxis ? -delta : delta) * hipsPositionScale;
          const basePosition = vrm.humanoid.normalizedRestPose.hips.position[axis] ?? 0;

          if (axis === 1) {
            values[i + axis] = allowVerticalMotion
              ? basePosition + adjustedDelta * VERTICAL_MOTION_DAMPING
              : basePosition;
          } else {
            values[i + axis] = basePosition;
          }
        }
      }

      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${boneInfo.propertyName}`, track.times, values));

      if (allowFloorMotion && boneInfo.vrmBoneName === 'hips' && rootMotionNodeName) {
        const rootMotionValues = track.values.slice();

        for (let i = 0; i < rootMotionValues.length; i += 3) {
          workingVector
            .set(
              (rootMotionValues[i] - firstFrame[0]) * hipsPositionScale,
              0,
              (rootMotionValues[i + 2] - firstFrame[2]) * hipsPositionScale
            )
            .applyQuaternion(parentRestWorldRotation);

          if (vrm.meta?.metaVersion === '0') {
            workingVector.x *= -1;
            workingVector.z *= -1;
          }

          rootMotionValues[i] = workingVector.x * FLOOR_MOTION_DAMPING;
          rootMotionValues[i + 1] = 0;
          rootMotionValues[i + 2] = workingVector.z * FLOOR_MOTION_DAMPING;
        }

        const lastIndex = rootMotionValues.length - 3;
        const finalX = rootMotionValues[lastIndex] ?? 0;
        const finalZ = rootMotionValues[lastIndex + 2] ?? 0;
        const finalDistance = Math.hypot(finalX, finalZ);

        if (finalDistance > MAX_FLOOR_TRAVEL_METERS) {
          const distanceScale = MAX_FLOOR_TRAVEL_METERS / finalDistance;

          for (let i = 0; i < rootMotionValues.length; i += 3) {
            rootMotionValues[i] *= distanceScale;
            rootMotionValues[i + 2] *= distanceScale;
          }
        }

        tracks.push(new THREE.VectorKeyframeTrack(`${rootMotionNodeName}.position`, track.times, rootMotionValues));
      }

      debugInfo.mappedTrackCount += 1;
      debugInfo.mappedBones.add(boneInfo.mixamoRigName);
    }
  });

  if (tracks.length === 0) {
    const sampleTracks = clip.tracks.slice(0, 5).map((track) => track.name).join(' | ');
    throw new Error(`No compatible humanoid tracks were found. Sample FBX tracks: ${sampleTracks}`);
  }

  console.log(
    `[Mixamo] Retargeted ${debugInfo.mappedTrackCount} tracks` +
    (excludeFingers ? `, dropped ${debugInfo.skippedFingerTrackCount} finger tracks (posed by gesture layer)` : '') +
    '.'
  );

  if (DEBUG_MIXAMO) {
    console.info('Mixamo debug:', {
      ...debugInfo,
      mappedBones: [...debugInfo.mappedBones],
      hipsPositionScale,
      allowVerticalMotion,
      allowFloorMotion
    });
  }

  return new THREE.AnimationClip('vrmMixamoAnimation', clip.duration, tracks);
}
