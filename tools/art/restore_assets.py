#!/usr/bin/env python3
"""Local restoration of the owner's design kit; never sends images to a service.

Requires Pillow and the official Real-ESRGAN ncnn executable with its models.
The executable/models are deliberately not included in the website repository.
"""

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--art", type=Path, required=True)
    args = parser.parse_args()
    kit, runtime, art = (p.resolve() for p in (args.kit, args.runtime, args.art))
    jobs = []
    for target in sorted(art.rglob("*.webp")):
        relative = target.relative_to(art)
        if relative.parts[0] in {"lockers", "textures", "furniture"} or target.name in {"tagline-s01.webp", "home-no-lamp.webp"}:
            continue  # Doors and the corrected tagline are live HTML/CSS.
        background = relative.parts[0] == "backgrounds"
        source = kit / ("backgrounds/png" if background else "assets/png")
        source /= relative.name.replace(".webp", ".png") if background else relative.with_suffix(".png")
        if not source.is_file():
            raise FileNotFoundError(source)
        jobs.append((source, target, background))

    manifest = {"model": "realesrgan-x4plus", "scale": 4, "assets": []}
    # Stage the entire batch before replacing files, so a failed inference leaves assets intact.
    with tempfile.TemporaryDirectory(prefix="perepev-art-") as temp:
        root = Path(temp)
        inputs, outputs = root / "in", root / "out"
        inputs.mkdir()
        outputs.mkdir()
        for index, (source, _, background) in enumerate(jobs):
            with Image.open(source) as original:
                picture = original.convert("RGB" if background else "RGBA")
                if background:
                    # 1920px exports were interpolated from small originals. Return near
                    # native detail density, retaining the exact assembled composition.
                    picture = picture.resize((640, 360), Image.Resampling.LANCZOS)
                picture.save(inputs / f"{index:03}.png")
        subprocess.run([
            str(runtime / "realesrgan-ncnn-vulkan"), "-i", str(inputs), "-o", str(outputs),
            "-m", str(runtime / "models"), "-n", "realesrgan-x4plus", "-s", "4", "-f", "png",
        ], check=True)
        staged = []
        for index, (source, target, background) in enumerate(jobs):
            with Image.open(outputs / f"{index:03}.png") as restored:
                staged_file = root / f"{index:03}.webp"
                restored.save(staged_file, quality=93, method=6, alpha_quality=100)
                with Image.open(source) as original:
                    source_size = list(original.size)
                manifest["assets"].append({
                    "file": str(target.relative_to(art)),
                    "source": str(source.relative_to(kit)),
                    "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "source_size": source_size,
                    "model_input_size": [640, 360] if background else source_size,
                    "output_size": list(restored.size),
                })
                staged.append((staged_file, target))
        for staged_file, target in staged:
            target.write_bytes(staged_file.read_bytes())
    (art / "RESTORATION.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Restored {len(jobs)} assets locally")


if __name__ == "__main__":
    main()
