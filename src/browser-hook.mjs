import * as THREE from "three"

const SPECIAL_PROFILE = /^(particle|masked-particle|additive|toon-water|ocean-tides|depth-water|water-foam|lava-flow)/

export function installViewerExtractionHook(context) {
  const {
    sceneData,
    renderAssets,
    mapRoot,
    world,
    camera,
    renderer,
    canvas,
    grid,
    spatialMeshes,
    materials,
    buildState,
    updateUnityShaderFrame
  } = context

  const materialDefinitions = new Map(
    (renderAssets.materials || []).map(definition => [
      materialKey(definition.asset, definition.fileId),
      definition
    ])
  )
  const definitionByMaterial = new Map()
  for (const [key, material] of materials.entries()) {
    const definition = materialDefinitions.get(key)
    if (definition) definitionByMaterial.set(material, definition)
  }

  const instancesById = new Map()
  const materialUsesByInstance = new Map()
  const instanceNumbers = new Map()
  const instanceRows = []

  function getMaterialDefinition(material) {
    return definitionByMaterial.get(material) || null
  }

  function materialMetadata(material) {
    const definition = getMaterialDefinition(material)
    const profile = definition?.shader?.profile || "unknown"
    const mainTexture = definition?.textures?.find(item => item.property === "_MainTex")
    return {
      asset: definition?.asset || null,
      fileId: definition?.fileId ?? null,
      name: definition?.name || material.name || "unnamed",
      profile,
      textureAsset: mainTexture?.texture?.asset || null,
      stylable: !isExcluded(material, definition)
    }
  }

  function isExcluded(material, definition = getMaterialDefinition(material)) {
    const profile = definition?.shader?.profile || ""
    return Boolean(
      material?.transparent
      || definition?.shader?.transparent
      || Number(definition?.renderQueue) >= 3000
      || SPECIAL_PROFILE.test(profile)
    )
  }

  function addInstance(instance, layerName) {
    if (!instance?.id) return null
    instancesById.set(instance.id, { instance, layerName })
    if (!instanceNumbers.has(instance.id)) {
      const number = instanceRows.length + 1
      if (number > 0xffffff) throw new Error("This map exceeds the 24-bit instance ID limit")
      instanceNumbers.set(instance.id, number)
      instanceRows.push({ number, instance, layerName, materials: new Map() })
    }
    return instanceNumbers.get(instance.id)
  }

  function addMaterialUse(instanceId, material) {
    if (!instanceId) return
    const metadata = materialMetadata(material)
    let materialMap = materialUsesByInstance.get(instanceId)
    if (!materialMap) {
      materialMap = new Map()
      materialUsesByInstance.set(instanceId, materialMap)
    }
    const identity = `${metadata.asset || ""}|${metadata.fileId ?? ""}|${metadata.name}`
    materialMap.set(identity, metadata)
    const row = instanceRows[instanceNumbers.get(instanceId) - 1]
    row?.materials.set(identity, metadata)
  }

  mapRoot.traverse(object => {
    if (object.isInstancedMesh && Array.isArray(object.userData.tiles)) {
      object.userData.tiles.forEach(tile => addInstance(tile.instance, tile.layerName))
    } else if (object.isMesh && object.userData.instance) {
      addInstance(object.userData.instance, object.userData.layerName || "unknown")
    }
  })

  mapRoot.traverse(object => {
    if (!object.isMesh) return
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
    if (object.isInstancedMesh && Array.isArray(object.userData.tiles)) {
      for (const tile of object.userData.tiles) {
        if (!tile?.instance?.id) continue
        for (const material of meshMaterials) addMaterialUse(tile.instance.id, material)
      }
    } else if (object.userData.instance?.id) {
      for (const material of meshMaterials) addMaterialUse(object.userData.instance.id, material)
    }
  })

  const textureAssets = [...new Set(
    instanceRows.flatMap(row => [...row.materials.values()]
      .map(material => material.textureAsset)
      .filter(Boolean))
  )].sort()
  const textureIds = new Map(textureAssets.map((asset, index) => [asset, index + 1]))

  function getSourceTexture(material) {
    return material?.map
      || material?.uniforms?.mainTexture?.value
      || material?.uniforms?.baseMap?.value
      || null
  }

  function getUvTransform(material, texture) {
    const transform = material?.uniforms?.mainTransform?.value
    if (transform?.isMatrix3) return transform.clone()
    if (texture?.matrix?.isMatrix3) return texture.matrix.clone()
    return new THREE.Matrix3()
  }

  function getTint(material) {
    const tint = material?.uniforms?.tint?.value
    if (tint?.isVector4) return tint.clone()
    if (material?.color?.isColor) {
      return new THREE.Vector4(
        material.color.r,
        material.color.g,
        material.color.b,
        Number.isFinite(material.opacity) ? material.opacity : 1
      )
    }
    return new THREE.Vector4(1, 1, 1, 1)
  }

  function createPassMaterial(sourceMaterial, pass) {
    const definition = getMaterialDefinition(sourceMaterial)
    const texture = getSourceTexture(sourceMaterial)
    const textureAsset = materialMetadata(sourceMaterial).textureAsset
    const textureId = textureIds.get(textureAsset) || 0
    const usesMainTexture = Boolean(texture && textureAsset)
    const transform = getUvTransform(sourceMaterial, texture)
    const tint = getTint(sourceMaterial)
    const alphaTest = Number(sourceMaterial?.alphaTest) || 0
    const side = sourceMaterial?.side ?? THREE.FrontSide
    const profile = definition?.shader?.profile || "unknown"
    const excluded = isExcluded(sourceMaterial, definition)
    const mode = pass === "fx" ? "fx" : pass
    const shouldSkip = excluded && mode !== "fx"
      || !excluded && mode === "fx"

    const uniforms = {
      uMainTexture: { value: texture },
      uHasMainTexture: { value: usesMainTexture },
      uUVTransform: { value: transform },
      uAlphaTest: { value: alphaTest },
      uTextureId: { value: textureId },
      uTint: { value: tint },
      uInstanceColor: { value: new THREE.Vector3() },
      uGlobalShear: { value: Number(sceneData.shaderGlobals?.shear) || 0 },
      uShearReference: { value: mapRoot.userData.shearReference || new THREE.Vector2() },
      uShearOffset: { value: Number(definition?.floats?._ShearOffset ?? -999) },
      uApplyShear: { value: Boolean(definition?.shader?.usesGlobalShear) }
    }

    const shader = new THREE.ShaderMaterial({
      uniforms,
      side,
      transparent: false,
      depthTest: !shouldSkip,
      depthWrite: !shouldSkip,
      colorWrite: !shouldSkip,
      toneMapped: false,
      vertexShader: `
        uniform mat3 uUVTransform;
        uniform float uGlobalShear;
        uniform vec2 uShearReference;
        uniform float uShearOffset;
        uniform bool uApplyShear;
        uniform vec3 uInstanceColor;
        varying vec2 vMapUv;
        varying vec3 vPassColor;
        varying float vLinearDepth;

        void main() {
          vec4 localPosition = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            localPosition = instanceMatrix * localPosition;
          #endif
          vec4 worldPosition = modelMatrix * localPosition;
          if (uApplyShear && abs(uGlobalShear) > 0.000001) {
            float targetY = uShearOffset > -100.0 ? uShearOffset : worldPosition.y;
            float targetHeight = targetY - uShearReference.y;
            worldPosition.x += uGlobalShear * targetHeight
              * (worldPosition.x - uShearReference.x);
          }
          #ifdef USE_INSTANCING_COLOR
            vPassColor = instanceColor;
          #else
            vPassColor = uInstanceColor;
          #endif
          vMapUv = (uUVTransform * vec3(uv, 1.0)).xy;
          vec4 viewPosition = viewMatrix * worldPosition;
          vLinearDepth = -viewPosition.z;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMainTexture;
        uniform bool uHasMainTexture;
        uniform float uAlphaTest;
        uniform float uTextureId;
        uniform vec4 uTint;
        varying vec2 vMapUv;
        varying vec3 vPassColor;
        varying float vLinearDepth;
        ${mode === "albedo" ? `
          float linearToSrgb(float value) {
            return value <= 0.0031308
              ? value * 12.92
              : 1.055 * pow(max(value, 0.0), 1.0 / 2.4) - 0.055;
          }
        ` : ""}

        void main() {
          vec4 source = uHasMainTexture
            ? texture2D(uMainTexture, vMapUv)
            : vec4(1.0);
          if (uAlphaTest > 0.0 && source.a < uAlphaTest) discard;
          ${mode === "albedo" ? `
            gl_FragColor = vec4(
              linearToSrgb(source.r),
              linearToSrgb(source.g),
              linearToSrgb(source.b),
              source.a
            );
          ` : mode === "id" ? `
            gl_FragColor = vec4(vPassColor, 1.0);
          ` : mode === "uv" ? `
            if (!uHasMainTexture) discard;
            gl_FragColor = vec4(vMapUv, uTextureId, 1.0);
          ` : mode === "depth" ? `
            gl_FragColor = vec4(vLinearDepth, 0.0, 0.0, 1.0);
          ` : `
            gl_FragColor = vec4(1.0);
          `}
        }
      `
    })
    shader.name = `map-extract:${mode}:${profile}`
    shader.userData.sourceMaterial = sourceMaterial
    return shader
  }

  function registerRows() {
    return instanceRows.map(row => {
      const instance = row.instance
      const tileset = (sceneData.tilesets || []).find(item => item.index === instance.tilesetIndex) || {}
      const materialsForRow = [...row.materials.values()]
      return {
        id: row.number,
        instanceId: instance.id,
        prototypeId: instance.prototypeId,
        tileName: instance.tileName,
        layerName: row.layerName,
        tilesetId: tileset.packageId || null,
        tilesetName: tileset.name || null,
        tileIndex: instance.tileIndex,
        position: instance.position,
        rotation: instance.rotation,
        materials: materialsForRow,
        textures: [...new Set(materialsForRow.map(item => item.textureAsset).filter(Boolean))].sort(),
        stylable: materialsForRow.some(item => item.stylable)
      }
    })
  }

  function colorFromId(id) {
    return new THREE.Color().setRGB(
      (id & 0xff) / 255,
      ((id >>> 8) & 0xff) / 255,
      ((id >>> 16) & 0xff) / 255,
      THREE.LinearSRGBColorSpace
    )
  }

  function prepareInstanceColors() {
    mapRoot.traverse(object => {
      if (!object.isInstancedMesh || !Array.isArray(object.userData.tiles)) return
      if (!savedInstanceColors.has(object)) {
        savedInstanceColors.set(object, object.instanceColor?.clone() || null)
      }
      object.userData.tiles.forEach((tile, index) => {
        const id = instanceNumbers.get(tile.instance?.id)
        if (id) object.setColorAt(index, colorFromId(id))
      })
      if (object.instanceColor) object.instanceColor.needsUpdate = true
    })
  }

  function restoreInstanceColors() {
    for (const [object, colorAttribute] of savedInstanceColors) {
      object.instanceColor = colorAttribute
      if (object.instanceColor) object.instanceColor.needsUpdate = true
    }
    savedInstanceColors.clear()
  }

  function snapshotCamera(width, height) {
    camera.updateMatrixWorld(true)
    const viewSize = Math.abs(camera.top - camera.bottom) / (camera.zoom || 1)
    return {
      projection: "orthographic",
      width,
      height,
      aspect: width / height,
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      up: camera.up.toArray(),
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom,
      frustum: {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom
      },
      pxPerUnit: height / Math.max(viewSize, 1e-9),
      viewMatrix: camera.matrixWorldInverse.toArray(),
      projectionMatrix: camera.projectionMatrix.toArray(),
      viewProjectionMatrix: new THREE.Matrix4()
        .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        .toArray(),
      coordinates: {
        source: "Unity coordinates",
        viewerXFlip: true,
        glbXFlipAppliedAtInstancePosition: true,
        shear: Number(sceneData.shaderGlobals?.shear) || 0,
        defaultView: "viewer fitView orthographic 45-degree azimuth/elevation"
      }
    }
  }

  const savedVisibility = new Map()
  const savedMaterials = new Map()
  const savedInstanceColors = new Map()
  const passMaterialCache = new Map()

  function makeSceneExtractionOnly() {
    world.traverse(object => {
      if (object.isLight) return
      const visible = object === mapRoot || mapRoot.parent === object
      if (!savedVisibility.has(object)) savedVisibility.set(object, object.visible)
      if (object !== world && !visible && !mapRoot.getObjectById(object.id)) object.visible = false
    })
    if (grid) grid.visible = false
    for (const mesh of spatialMeshes || []) mesh.visible = false
    if (mapRoot.parent !== world) world.add(mapRoot)
    mapRoot.visible = true
    world.background = null
  }

  function getPassMaterial(source, mode, instanceId = null) {
    const cacheKey = `${mode}:${instanceId || 0}`
    let byMode = passMaterialCache.get(source)
    if (!byMode) {
      byMode = new Map()
      passMaterialCache.set(source, byMode)
    }
    if (!byMode.has(cacheKey)) {
      const material = createPassMaterial(source, mode)
      if (instanceId) material.uniforms.uInstanceColor.value.copy(colorFromId(instanceId))
      byMode.set(cacheKey, material)
    }
    return byMode.get(cacheKey)
  }

  function swapMaterials(mode) {
    savedMaterials.clear()
    mapRoot.traverse(object => {
      if (!object.isMesh) return
      const sourceMaterials = object.material
      savedMaterials.set(object, sourceMaterials)
      const replace = source => {
        const id = object.isInstancedMesh
          ? null
          : instanceNumbers.get(object.userData.instance?.id)
        return getPassMaterial(source, mode, id)
      }
      object.material = Array.isArray(sourceMaterials)
        ? sourceMaterials.map(replace)
        : replace(sourceMaterials)
    })
  }

  function restoreMaterials() {
    for (const [object, material] of savedMaterials) object.material = material
    savedMaterials.clear()
  }

  function pngFromPixels(pixels, width, height) {
    const flipped = new Uint8ClampedArray(pixels.length)
    const stride = width * 4
    for (let y = 0; y < height; y += 1) {
      flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride)
    }
    const output = document.createElement("canvas")
    output.width = width
    output.height = height
    output.getContext("2d", { willReadFrequently: false })
      .putImageData(new ImageData(flipped, width, height), 0, 0)
    return output.toDataURL("image/png").slice("data:image/png;base64,".length)
  }

  function pngFromLinearPixels(pixels, width, height) {
    const encoded = new Uint8ClampedArray(pixels.length)
    for (let index = 0; index < pixels.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = Math.max(0, pixels[index + channel])
        const srgb = value <= 0.0031308
          ? value * 12.92
          : 1.055 * Math.pow(value, 1 / 2.4) - 0.055
        encoded[index + channel] = Math.round(Math.min(1, srgb) * 255)
      }
      encoded[index + 3] = Math.round(Math.min(1, Math.max(0, pixels[index + 3])) * 255)
    }
    return pngFromPixels(encoded, width, height)
  }

  function floatBase64(values) {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
    const chunkSize = 0x8000
    let binary = ""
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }
    return btoa(binary)
  }

  async function capture(pass) {
    const width = renderer.domElement.width
    const height = renderer.domElement.height
    if (!width || !height) throw new Error("Viewer canvas has zero dimensions")
    makeSceneExtractionOnly()
    renderer.setAnimationLoop(null)
    updateUnityShaderFrame(0, width, height)

    const cameraInfo = snapshotCamera(width, height)
    if (pass === "beauty") {
      const target = new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        internalFormat: "RGBA32F",
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false
      })
      target.texture.colorSpace = THREE.LinearSRGBColorSpace
      target.samples = 0
      const oldBackground = world.background
      world.background = new THREE.Color(0x111720)
      try {
        renderer.setRenderTarget(target)
        renderer.clear(true, true, true)
        renderer.render(world, camera)
        const pixels = new Float32Array(width * height * 4)
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
        return {
          kind: "png-base64",
          width,
          height,
          data: pngFromLinearPixels(pixels, width, height),
          camera: cameraInfo
        }
      } finally {
        renderer.setRenderTarget(null)
        target.dispose()
        world.background = oldBackground
      }
    }

    const mode = pass === "mask_fx" ? "fx" : pass
    if (!["albedo", "id", "uv", "depth", "mask_fx"].includes(pass)) {
      throw new Error(`Unknown extraction pass: ${pass}`)
    }
    const floatPass = pass === "uv" || pass === "depth"
    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: floatPass ? THREE.FloatType : THREE.UnsignedByteType,
      internalFormat: floatPass ? "RGBA32F" : "RGBA8",
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false
    })
    target.texture.colorSpace = pass === "albedo" ? THREE.SRGBColorSpace : THREE.NoColorSpace
    target.texture.generateMipmaps = false
    target.samples = 0

    const oldColorSpace = renderer.outputColorSpace
    const oldToneMapping = renderer.toneMapping
    const oldBackground = world.background
    const oldClearColor = renderer.getClearColor(new THREE.Color()).clone()
    const oldClearAlpha = renderer.getClearAlpha()
    try {
      world.background = null
      renderer.outputColorSpace = pass === "albedo"
        ? THREE.SRGBColorSpace
        : THREE.LinearSRGBColorSpace
      renderer.toneMapping = THREE.NoToneMapping
      renderer.setClearColor(0x000000, 0)
      if (pass === "id") prepareInstanceColors()
      swapMaterials(mode)
      renderer.setRenderTarget(target)
      renderer.clear(true, true, true)
      renderer.render(world, camera)

      if (floatPass) {
        const pixels = new Float32Array(width * height * 4)
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
        return {
          kind: "float32-rgba-base64",
          width,
          height,
          data: floatBase64(pixels),
          camera: cameraInfo
        }
      }

      const pixels = new Uint8Array(width * height * 4)
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
      return {
        kind: "png-base64",
        width,
        height,
        data: pngFromPixels(pixels, width, height),
        camera: cameraInfo
      }
    } finally {
      restoreMaterials()
      if (pass === "id") restoreInstanceColors()
      renderer.setRenderTarget(null)
      renderer.outputColorSpace = oldColorSpace
      renderer.toneMapping = oldToneMapping
      renderer.setClearColor(oldClearColor, oldClearAlpha)
      world.background = oldBackground
      target.dispose()
      updateUnityShaderFrame(0, width, height)
    }
  }

  const rows = registerRows()
  const instanceMaterialRows = Object.fromEntries(
    rows.map(row => [row.id, row.materials])
  )
  const textureMap = Object.fromEntries(
    [...textureIds.entries()].map(([asset, id]) => [String(id), asset])
  )

  window.__mapExtraction = {
    ready: true,
    describe() {
      mapRoot.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(mapRoot)
      const center = bounds.getCenter(new THREE.Vector3())
      mapRoot.userData.shearReference = new THREE.Vector2(center.x, center.y)
      return {
        threeRevision: THREE.REVISION,
        map: sceneData.map,
        source: sceneData.source,
        derivedHash: sceneData.derivedHash,
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        instanceCount: rows.length,
        missingMeshes: buildState.missingMeshes,
        renderedNodes: buildState.renderedNodes,
        warnings: sceneData.warnings || [],
        renderWarnings: renderAssets.warnings || [],
        bounds: bounds.isEmpty()
          ? null
          : { min: bounds.min.toArray(), max: bounds.max.toArray(), center: center.toArray() },
        camera: snapshotCamera(renderer.domElement.width, renderer.domElement.height),
        ids: rows.map(({ id, instanceId, prototypeId, tileName, layerName, tilesetId, tilesetName, tileIndex, position, rotation, textures, stylable }) => ({
          id, instanceId, prototypeId, tileName, layerName, tilesetId, tilesetName,
          tileIndex, position, rotation, textures, stylable,
          materials: instanceMaterialRows[id]
        })),
        textureMap
      }
    },
    capture
  }
  renderer.setAnimationLoop(null)
  const gl = renderer.getContext()
  gl.disable(gl.DITHER)
}

function materialKey(asset, fileId) {
  return `${asset || ""}|${String(fileId ?? "")}`
}
