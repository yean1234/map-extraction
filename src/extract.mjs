#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PASSES = ["beauty", "albedo", "id", "mask_fx", "uv", "depth"]
const PNG_PASSES = new Set(["beauty", "albedo", "id", "mask_fx"])
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".exr", "image/x-exr"],
  [".gif", "image/gif"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"]
])

function usage() {
  console.log(`Usage: node src/extract.mjs --map-id <id-or-map-name> [options]

Options:
  --package <path>  Local tilemap package (or PACKAGE_DIR from .env)
  --out <path>      Output root (default: out/)
  --width <pixels>  Render width (default: 1024)
  --height <pixels> Render height (default: 1024)
  --chrome <path>   Chrome executable (or CHROME_PATH)
  --python <path>   Python executable (defaults to the repo .venv, then py -3)
  --help            Show this help

The run is written to out/extract-runs/<unique-run-id>/ and is never overwritten.`)
}

function parseArgs(argv) {
  const args = { width: 1024, height: 1024 }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === "--help" || key === "-h") {
      usage()
      process.exit(0)
    }
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    const name = key.slice(2)
    if (!["map-id", "package", "out", "width", "height", "chrome", "python"].includes(name)) {
      throw new Error(`Unknown option: ${key}`)
    }
    args[name] = ["width", "height"].includes(name) ? Number.parseInt(value, 10) : value
    index += 1
  }
  if (!args["map-id"]) throw new Error("--map-id is required")
  if (![args.width, args.height].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error("--width and --height must be positive integers")
  }
  return args
}

function envFile() {
  return readFile(path.join(ROOT, ".env"), "utf8").catch(error => {
    if (error.code === "ENOENT") return ""
    throw error
  })
}

function parseEnv(text) {
  const result = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const split = trimmed.indexOf("=")
    if (split > 0) result[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim().replace(/^['"]|['"]$/g, "")
  }
  return result
}

function expandPath(value) {
  return value
    .replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => process.env[key] || `$${key}`)
}

function absoluteFromRoot(value) {
  const expanded = expandPath(value)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(ROOT, expanded)
}

async function resolveConfiguration(args) {
  const env = parseEnv(await envFile())
  const packageValue = args.package || process.env.PACKAGE_DIR || env.PACKAGE_DIR
  if (!packageValue) {
    throw new Error("PACKAGE_DIR is missing. Copy .env.example to .env and set the local package path.")
  }
  const packageRoot = absoluteFromRoot(packageValue)
  const packageManifestPath = path.join(packageRoot, "manifest.json")
  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"))
  if (packageManifest.format !== "tilemap-dataset-package") {
    throw new Error(`Not a tilemap-dataset-package: ${packageManifestPath}`)
  }
  const out = absoluteFromRoot(args.out || process.env.OUT_DIR || env.OUT_DIR || "out")
  const python = await resolvePython(args.python || process.env.PYTHON || env.PYTHON)
  const chrome = await resolveChrome(args.chrome || process.env.CHROME_PATH || env.CHROME_PATH)
  return { packageRoot, packageManifest, out, python, chrome }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolvePython(preferred) {
  if (preferred) {
    return path.isAbsolute(preferred) || preferred.includes("/") || preferred.includes("\\")
      ? absoluteFromRoot(preferred)
      : preferred
  }
  const local = process.platform === "win32"
    ? path.join(ROOT, ".venv", "Scripts", "python.exe")
    : path.join(ROOT, ".venv", "bin", "python")
  if (await exists(local)) return local
  return process.platform === "win32" ? "py" : "python3"
}

async function resolveChrome(preferred) {
  if (preferred) {
    return path.isAbsolute(preferred) || preferred.includes("/") || preferred.includes("\\")
      ? absoluteFromRoot(preferred)
      : preferred
  }
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  throw new Error("Chrome/Edge not found. Set CHROME_PATH in .env or pass --chrome.")
}

function pythonArgs(python, args) {
  if (path.basename(python).toLowerCase() === "py" || path.basename(python).toLowerCase() === "py.exe") {
    return ["-3", ...args]
  }
  return args
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      stdio: options.stdio || "inherit",
      windowsHide: true,
      ...options.spawnOptions
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${signal || `code ${code}`}`))
    })
  })
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function safePackagePath(root, urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const resolved = path.resolve(root, `.${decoded}`)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside the package root")
  }
  return resolved
}

function injectViewerHook(source) {
  const importMarker = 'import * as THREE from "three"\n'
  const initializeMarker = "  addGrid(sceneBounds)\n  fitView()\n\n  const warningCount"
  if (!source.includes(importMarker) || !source.includes(initializeMarker)) {
    throw new Error("package/viewer.js changed: expected hook insertion points were not found")
  }
  return source
    .replace(importMarker, `${importMarker}import { installViewerExtractionHook } from "/__map_extract/browser-hook.mjs"\n`)
    .replace(initializeMarker, `  addGrid(sceneBounds)\n  fitView()\n\n  installViewerExtractionHook({\n    sceneData, renderAssets, mapRoot, world, camera, renderer, canvas, grid,\n    spatialMeshes, materials, buildState, updateUnityShaderFrame\n  })\n\n  const warningCount`)
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream"
}

async function startPackageServer(packageRoot) {
  const hookPath = path.join(ROOT, "src", "browser-hook.mjs")
  const viewerPath = path.join(packageRoot, "viewer.js")
  const source = injectViewerHook(await readFile(viewerPath, "utf8"))
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1")
      if (url.pathname === "/__map_extract/browser-hook.mjs") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" })
        response.end(await readFile(hookPath))
        return
      }
      const filePath = safePackagePath(packageRoot, url.pathname === "/" ? "/index.html" : url.pathname)
      const fileInfo = await stat(filePath)
      if (!fileInfo.isFile()) throw new Error("Not a file")
      const responseBody = filePath === viewerPath ? Buffer.from(source) : null
      response.writeHead(200, {
        "Content-Length": responseBody?.byteLength ?? fileInfo.size,
        "Content-Type": contentType(filePath),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      })
      if (responseBody) response.end(responseBody)
      else createReadStream(filePath).pipe(response)
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 400, { "Content-Type": "text/plain; charset=utf-8" })
      response.end(error.code === "ENOENT" ? "Not found" : error.message)
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return { server, port: server.address().port }
}

class DevTools {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.runtimeErrors = []
    socket.addEventListener("message", event => {
      let message
      try {
        message = JSON.parse(event.data.toString())
      } catch {
        return
      }
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params?.exceptionDetails
        this.runtimeErrors.push(detail?.exception?.description || detail?.text || "Runtime exception")
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result || {})
    })
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools connection closed"))
      this.pending.clear()
    })
  }

  async send(method, params = {}) {
    const id = this.nextId++
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return response
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result?.value
  }
}

async function connectChrome(port, browserProcess) {
  const deadline = Date.now() + 30_000
  let target
  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) throw new Error(`Chrome exited with code ${browserProcess.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      target = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl)
      if (target) break
    } catch {
      // Chrome's DevTools endpoint is not ready yet.
    }
    await delay(150)
  }
  if (!target) throw new Error("Chrome DevTools did not become ready")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  const devtools = new DevTools(socket)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  return { devtools, socket, browserVersion: version.Browser }
}

async function waitForViewer(devtools) {
  const deadline = Date.now() + 180_000
  let lastMessage = "loading"
  while (Date.now() < deadline) {
    const state = await devtools.evaluate(`(() => ({\
      ready: Boolean(window.__mapExtraction?.ready),\
      status: document.querySelector('#status')?.textContent || '',\
      state: document.querySelector('#status')?.dataset.state || ''\
    }))()`)
    if (state?.ready) return
    lastMessage = state?.status || lastMessage
    if (state?.state === "error") throw new Error(`Viewer failed to assemble map: ${lastMessage}`)
    await delay(250)
  }
  throw new Error(`Timed out loading map in headless viewer: ${lastMessage}`)
}

async function hashFile(filePath) {
  const hash = createHash("sha256")
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on("data", chunk => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
  return hash.digest("hex")
}

function toPackageRelative(filePath, packageRoot) {
  const relative = path.relative(packageRoot, filePath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Source path is outside the package: ${filePath}`)
  }
  return relative.split(path.sep).join("/")
}

async function sourceHashes({ packageRoot, packageManifest, sceneData, renderAssets, textureMap }) {
  const files = new Set([
    sceneData.__mapPath,
    "assets/render-assets.json",
    "viewer.js",
    "unity-materials.js"
  ])
  const tilesetsById = new Map(packageManifest.tilesets.map(item => [item.id, item]))
  for (const tileset of sceneData.tilesets || []) {
    const entry = tilesetsById.get(tileset.packageId)
    if (entry?.path) files.add(entry.path)
  }
  const modelsByAsset = new Map(renderAssets.models.map(item => [item.asset, item]))
  for (const asset of sceneData.renderDependencies?.models || []) {
    const definition = modelsByAsset.get(asset)
    if (definition?.output) files.add(path.posix.join("assets", definition.output))
  }
  const textureAssets = new Set(Object.values(textureMap))
  const dependencyKeys = new Set((sceneData.renderDependencies?.materials || [])
    .map(item => `${item.asset || ""}|${item.fileId ?? ""}`))
  for (const material of renderAssets.materials) {
    if (!dependencyKeys.has(`${material.asset || ""}|${material.fileId ?? ""}`)) continue
    for (const entry of material.textures || []) {
      if (entry.texture?.asset) textureAssets.add(entry.texture.asset)
    }
  }
  const texturesByAsset = new Map(renderAssets.textures.map(item => [item.asset, item]))
  for (const asset of textureAssets) {
    const definition = texturesByAsset.get(asset)
    if (definition?.output) files.add(path.posix.join("assets", definition.output))
  }

  const entries = {}
  const missing = []
  for (const relative of [...files].filter(Boolean).sort()) {
    const fullPath = path.resolve(packageRoot, relative)
    if (!fullPath.startsWith(`${packageRoot}${path.sep}`)) throw new Error(`Unsafe source path: ${relative}`)
    if (!await exists(fullPath)) {
      missing.push(relative)
      continue
    }
    entries[toPackageRelative(fullPath, packageRoot)] = await hashFile(fullPath)
  }
  return { sha256: entries, missing }
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

async function capturePass(devtools, pass) {
  return devtools.evaluate(`window.__mapExtraction.capture(${JSON.stringify(pass)})`)
}

async function outputDigestMap(runDir) {
  const files = []
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const filePath = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(filePath)
      else if (entry.name !== "extract-manifest.json") files.push(filePath)
    }
  }
  await walk(runDir)
  const result = {}
  for (const filePath of files.sort()) {
    result[path.relative(runDir, filePath).split(path.sep).join("/")] = await hashFile(filePath)
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = await resolveConfiguration(args)
  const mapEntry = config.packageManifest.maps.find(item =>
    item.id === args["map-id"] || item.name === args["map-id"]
  )
  if (!mapEntry) throw new Error(`Map not found in package: ${args["map-id"]}`)

  const mapPath = path.resolve(config.packageRoot, mapEntry.path)
  if (!mapPath.startsWith(`${config.packageRoot}${path.sep}`)) throw new Error("Map path escapes the package")
  const sceneData = JSON.parse(await readFile(mapPath, "utf8"))
  sceneData.__mapPath = mapEntry.path
  const assetsIndexPath = path.join(config.packageRoot, "assets", "render-assets.json")
  const renderAssets = JSON.parse(await readFile(assetsIndexPath, "utf8"))
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const mapSlug = (sceneData.map?.name || mapEntry.name || mapEntry.id)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "map"
  const runId = `${stamp}_${mapSlug}_${randomUUID().slice(0, 8)}`
  const runDir = path.join(config.out, "extract-runs", runId)
  await mkdir(path.dirname(runDir), { recursive: true })
  await mkdir(runDir, { recursive: false })
  const viewDir = path.join(runDir, "views", "game")
  await mkdir(viewDir, { recursive: true })

  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "map-extract-"))
  const browserPort = await unusedPort()
  const packageServer = await startPackageServer(config.packageRoot)
  let browserProcess
  let devtools
  let socket
  let qaPassed = false

  try {
    browserProcess = spawn(config.chrome, [
      "--headless=new",
      `--remote-debugging-port=${browserPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${path.join(temporaryDir, "profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--force-device-scale-factor=1",
      "about:blank"
    ], { stdio: "ignore", windowsHide: true })
    browserProcess.once("error", error => console.error(`Chrome launch failed: ${error.message}`))

    const connection = await connectChrome(browserPort, browserProcess)
    devtools = connection.devtools
    socket = connection.socket
    await devtools.send("Page.enable")
    await devtools.send("Runtime.enable")
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: 1,
      mobile: false
    })
    await devtools.send("Page.navigate", {
      url: `http://127.0.0.1:${packageServer.port}/?map=${encodeURIComponent(mapEntry.id)}`
    })
    await waitForViewer(devtools)

    const description = await devtools.evaluate("window.__mapExtraction.describe()")
    if (!description || description.width !== args.width || description.height !== args.height) {
      throw new Error(`Unexpected render size: ${description?.width}x${description?.height}; requested ${args.width}x${args.height}`)
    }
    const allTextureDefinitions = new Map(renderAssets.textures.map(item => [item.asset, item]))
    const textureInfo = Object.fromEntries(Object.entries(description.textureMap).map(([id, asset]) => {
      const definition = allTextureDefinitions.get(asset)
      return [id, definition
        ? { asset, output: definition.output, importSettings: definition.importSettings || {} }
        : null]
    }))

    const hashes = {}
    const firstCaptures = {}
    for (const pass of PASSES) {
      console.log(`Rendering ${pass}...`)
      const capture = await capturePass(devtools, pass)
      if (!capture?.data || !capture.kind) throw new Error(`Viewer returned an empty ${pass} pass`)
      const payload = Buffer.from(capture.data, "base64")
      hashes[pass] = createHash("sha256").update(payload).digest("hex")
      firstCaptures[pass] = capture
      if (PNG_PASSES.has(pass)) {
        const outputFilename = pass === "id" ? "instance_id.png" : `${pass}.png`
        await writeFile(path.join(viewDir, outputFilename), payload)
      } else {
        const temporaryRaw = path.join(temporaryDir, `${pass}.rgba.f32`)
        const outputName = `${pass}.rgba.f32`
        await writeFile(temporaryRaw, payload)
        const output = path.join(runDir, outputName)
        await writeFile(output, payload)
        firstCaptures[pass].__rawPath = output
        firstCaptures[pass].__tempPath = temporaryRaw
      }
    }

    const secondHashes = {}
    for (const pass of PASSES) {
      const capture = await capturePass(devtools, pass)
      secondHashes[pass] = createHash("sha256").update(Buffer.from(capture.data, "base64")).digest("hex")
      if (pass === "beauty") {
        await writeFile(path.join(runDir, ".beauty-repeat.png"), Buffer.from(capture.data, "base64"))
      }
    }
    const determinism = {
      allMatch: PASSES.every(pass => hashes[pass] === secondHashes[pass]),
      firstPassSha256: hashes,
      repeatedPassSha256: secondHashes
    }
    for (const pass of ["uv", "depth"]) {
      const rawPath = firstCaptures[pass].__rawPath
      const outputPath = path.join(runDir, `${pass}.exr`)
      const script = path.join(ROOT, "src", "write_exr.py")
      await runProcess(config.python, pythonArgs(config.python, [
        script,
        "--kind", pass,
        "--input", rawPath,
        "--output", outputPath,
        "--width", String(args.width),
        "--height", String(args.height)
      ]))
      await rm(rawPath, { force: true })
    }

    const camera = firstCaptures.beauty.camera
    await writeJson(path.join(runDir, "camera.json"), {
      schemaVersion: 1,
      mapId: mapEntry.id,
      mapName: description.map?.name || mapEntry.name,
      view: "game-default",
      camera,
      bounds: description.bounds,
      coordinateConventions: camera.coordinates,
      renderSize: { width: args.width, height: args.height }
    })
    await writeJson(path.join(runDir, "id_map.json"), {
      schemaVersion: 1,
      mapId: mapEntry.id,
      instanceCount: description.instanceCount,
      textureMap: description.textureMap,
      instances: description.ids
    })

    const sourceFileHashes = await sourceHashes({
      packageRoot: config.packageRoot,
      packageManifest: config.packageManifest,
      sceneData,
      renderAssets,
      textureMap: description.textureMap
    })
    const extractManifest = {
      schemaVersion: 1,
      runId,
      createdAt: new Date().toISOString(),
      map: {
        id: mapEntry.id,
        name: description.map?.name || mapEntry.name,
        packagePath: mapEntry.path,
        pairStatus: mapEntry.pair?.status || "unknown",
        selectedSource: mapEntry.selectedSource || null,
        derivedHash: description.derivedHash || null
      },
      sourcePackage: "local-only; source assets remain outside this repository",
      sourceFiles: sourceFileHashes,
      viewer: {
        chrome: connection.browserVersion,
        threeRevision: description.threeRevision,
        renderSize: { width: args.width, height: args.height },
        passes: PASSES
      },
      scene: {
        instanceCount: description.instanceCount,
        renderedNodes: description.renderedNodes,
        missingMeshes: description.missingMeshes,
        bounds: description.bounds,
        warnings: description.warnings,
        renderWarnings: description.renderWarnings
      },
      determinism
    }
    await writeJson(path.join(runDir, "extract-manifest.json"), extractManifest)
    const qaInput = {
      ids: description.ids,
      textures: textureInfo,
      missingMeshes: description.missingMeshes,
      determinism
    }
    await writeJson(path.join(runDir, "qa-input.json"), qaInput)
    await runProcess(config.python, pythonArgs(config.python, [
      path.join(ROOT, "src", "qa.py"),
      "--run-dir", runDir,
      "--package", config.packageRoot
    ]))
    const qaReport = JSON.parse(await readFile(path.join(runDir, "qa-report.json"), "utf8"))
    qaPassed = qaReport.passed
    extractManifest.qa = {
      passed: qaReport.passed,
      report: "qa-report.json"
    }
    extractManifest.outputFiles = await outputDigestMap(runDir)
    await writeJson(path.join(runDir, "extract-manifest.json"), extractManifest)
    console.log(`Run written to ${runDir}`)
    console.log(`QA ${qaPassed ? "PASSED" : "FAILED"}; see qa-report.json`)
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close()
    let browserStopped = !browserProcess || browserProcess.exitCode !== null
    if (!browserStopped) {
      const exited = new Promise(resolve => browserProcess.once("exit", () => resolve(true)))
      browserProcess.kill()
      browserStopped = await Promise.race([exited, delay(5000).then(() => false)])
    }
    await new Promise(resolve => packageServer.server.close(() => resolve()))
    if (browserStopped) {
      try {
        await rm(temporaryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
      } catch (error) {
        console.warn(`Could not remove temporary Chrome profile ${temporaryDir}: ${error.message}`)
      }
    } else {
      console.warn(`Chrome did not stop promptly; temporary profile left at ${temporaryDir}`)
    }
  }
  if (!qaPassed) process.exitCode = 2
}

main().catch(error => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
