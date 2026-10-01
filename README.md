# map-extraction

로컬 타일맵 패키지를 기존 뷰어로 조립하고, 동일한 게임 시점에서 이미지·인스턴스 ID·UV·깊이를 추출하는 도구입니다. 회사 에셋과 결과물은 이 공개 저장소에 넣지 않습니다. 파이프라인은 `PACKAGE_DIR`에서 에셋을 읽고 `out/`에만 결과를 씁니다.

## 준비

필요 환경: Node.js 22 이상, Python 3.10 이상, Chrome 또는 Edge.

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

`.env`의 `PACKAGE_DIR`을 로컬 패키지 경로로 바꿉니다. 예를 들어 이 저장소와 `Asset` 폴더가 같은 상위 폴더에 있으면 `../Asset/package`를 사용할 수 있습니다. `.env`는 Git에서 제외됩니다. Chrome 위치를 자동으로 찾지 못하면 `CHROME_PATH`를 지정합니다.

## 파일럿 맵 찾기

```powershell
.\.venv\Scripts\python.exe src\s0_inventory.py
```

결과는 `out/inventory.json`에 저장됩니다. 맵 원본 쌍 상태, 타일 배치 수, 사용 타일셋, 경고, 미해결 프로토타입/메시를 기록하고 파일럿 후보를 정렬합니다. 현재 패키지에는 배치 인스턴스가 20~40개인 후보가 없어, S0는 맵의 X/Z 좌표 범위가 20~40인 맵을 찾고 배치 수가 적은 순으로 우선합니다. 실행 시 `--package <경로>`와 `--out <경로>`로 경로를 바꿀 수 있습니다.

## 추출 실행

맵 ID 또는 맵 이름을 지정합니다. 이름은 `out/inventory.json`이나 패키지의 `manifest.json`에서 확인할 수 있습니다.

```powershell
$mapId = "YOUR_MAP_ID"
node src/extract.mjs --map-id $mapId
```

해상도와 경로를 지정하려면:

```powershell
$mapId = "YOUR_MAP_ID"
node src/extract.mjs --map-id $mapId --width 1024 --height 1024
```

각 실행은 덮어쓰지 않는 고유 폴더 `out/extract-runs/<run-id>/`를 만듭니다. 렌더 이미지는 `views/game/` 아래에 생성됩니다.

| 파일 | 내용 |
|---|---|
| `beauty.png` | 뷰어 셰이더/재질을 사용한 고정 시점 오프스크린 렌더(UI·오버레이 제외) |
| `albedo.png` | 메인 텍스처 색상 패스(조명/틴트 제외) |
| `instance_id.png`, `id_map.json` | 픽셀의 인스턴스 ID와 타일·레이어·재질 메타데이터 |
| `uv.exr` | `U`, `V`, `TextureID`, `Valid` 채널 |
| `depth.exr` | 카메라 공간 선형 깊이 `Z`와 `Valid` 채널 |
| `mask_fx.png` | 변환 대상에서 제외한 투명/이펙트 재질 마스크 |
| `camera.json` | 직교 카메라 행렬, 화면 크기, 좌표계 규칙 |
| `extract-manifest.json` | 원본 파일 SHA-256, 뷰어/브라우저 버전, 출력 해시 |
| `qa-report.json` | ID·깊이·UV 역샘플링(PSNR 40dB 이상)·재현성 결과 |

정수 ID는 RGB 24비트로 저장하므로 한 맵에서 최대 16,777,215개 인스턴스를 표현할 수 있습니다. `uv.exr`와 `depth.exr`는 float 채널을 포함합니다. 두 번 렌더한 각 패스의 해시가 다른 경우나 UV 왕복 PSNR이 40dB 미만인 경우 QA는 실패로 기록됩니다. 실패해도 산출물과 보고서는 확인할 수 있습니다.

## 에셋 보호

Git에는 파이프라인 코드와 문서만 올립니다. `.env`, `out/`, 패키지·맵·타일셋, 이미지, GLB/FBX, EXR, NDA 문서는 `.gitignore` 대상입니다. 원본 에셋은 로컬 `PACKAGE_DIR`에서만 읽습니다. 모델 API 등 외부 서비스로 이미지를 전송하지 않습니다.
