#!/usr/bin/env python3
"""Generate original flat B&W pictogram stick-figure tray animations (6 poses).

Style: public-sign silhouette language inspired by Japanese pictogram characters
(not a copy of any copyrighted 皮特托先生 / exit-sign official art).

Outputs under assets/tray/:
  - {pose}.gif / {pose}.webm deliverables
  - frames/{pose}/00.png … for Electron setImage frame animation
  - manifest.json
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / "assets" / "tray"
FRAMES = ROOT / "frames"
SIZE = 44
FPS = 8
FRAMES_PER_POSE = 8

POSES = [
    ("lie-flat", "躺平"),
    ("stand-and-wave", "站立打招呼"),
    ("squat-and-think", "蹲下思考"),
    ("bored-idle", "无聊发呆"),
    ("chase-butterfly", "追蝴蝶"),
    ("peek-from-edge", "从边缘伸头查看"),
]


def blank() -> Image.Image:
    return Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))


def stroke(draw: ImageDraw.ImageDraw, pts, w=3) -> None:
    if len(pts) < 2:
        return
    draw.line(pts, fill=(0, 0, 0, 255), width=w, joint="curve")


def head(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: int = 5) -> None:
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 255))


def limb(draw: ImageDraw.ImageDraw, a, b, w: int = 3) -> None:
    stroke(draw, [a, b], w)


def draw_pose(pose_id: str, t: float) -> Image.Image:
    """t in [0, 1) animation phase."""
    im = blank()
    d = ImageDraw.Draw(im)
    bob = math.sin(t * 2 * math.pi) * 1.2

    if pose_id == "lie-flat":
        y = 28 + bob * 0.3
        head(d, 12, y, 5)
        limb(d, (17, y), (34, y), 3)
        kick = math.sin(t * 2 * math.pi) * 3
        limb(d, (34, y), (40, y - 2 + kick), 3)
        limb(d, (34, y), (40, y + 2 - kick), 3)
        limb(d, (17, y), (14, y - 6), 2)

    elif pose_id == "stand-and-wave":
        cx = 18
        hy = 10 + bob * 0.4
        head(d, cx, hy, 5)
        hip = (cx, 28)
        limb(d, (cx, hy + 5), hip, 3)
        limb(d, hip, (cx - 5, 40), 3)
        limb(d, hip, (cx + 5, 40), 3)
        limb(d, (cx, 16), (cx - 8, 24), 3)
        wave = math.sin(t * 2 * math.pi) * 8
        hand = (cx + 10 + wave * 0.1, 8 + wave)
        limb(d, (cx, 16), hand, 3)

    elif pose_id == "squat-and-think":
        cx = 20
        hy = 14 + bob * 0.3
        head(d, cx, hy, 5)
        hip = (cx, 30)
        limb(d, (cx, hy + 5), hip, 3)
        knee_l = (cx - 6, 34)
        knee_r = (cx + 6, 34)
        limb(d, hip, knee_l, 3)
        limb(d, knee_l, (cx - 4, 40), 3)
        limb(d, hip, knee_r, 3)
        limb(d, knee_r, (cx + 4, 40), 3)
        limb(d, (cx, 18), (cx - 8, 30), 3)
        nod = math.sin(t * 2 * math.pi) * 1.5
        limb(d, (cx, 18), (cx + 6, hy + 2 + nod), 3)

    elif pose_id == "bored-idle":
        cx = 22
        sway = math.sin(t * 2 * math.pi) * 2
        hy = 10 + bob * 0.2
        head(d, cx + sway * 0.3, hy, 5)
        hip = (cx + sway * 0.2, 28)
        limb(d, (cx + sway * 0.3, hy + 5), hip, 3)
        limb(d, hip, (cx - 5 + sway, 40), 3)
        limb(d, hip, (cx + 5 + sway, 40), 3)
        limb(d, (cx, 16), (cx - 7 + sway, 28), 3)
        limb(d, (cx, 16), (cx + 7 + sway, 28), 3)
        zz = int(t * 3) % 3
        for i in range(zz + 1):
            zx = cx + 8 + i * 3
            zy = hy - 4 - i * 4 - abs(math.sin(t * 2 * math.pi + i)) * 1
            d.ellipse([zx, zy, zx + 2, zy + 2], fill=(0, 0, 0, 200))

    elif pose_id == "chase-butterfly":
        run = math.sin(t * 2 * math.pi)
        cx = 14 + run * 1.5
        hy = 12 + abs(run) * 1
        head(d, cx, hy, 5)
        hip = (cx + 2, 28)
        limb(d, (cx, hy + 5), hip, 3)
        limb(d, hip, (cx - 4 - run * 4, 40), 3)
        limb(d, hip, (cx + 6 + run * 4, 38), 3)
        limb(d, (cx, 16), (cx + 12, 10 + run * 2), 3)
        limb(d, (cx, 16), (cx - 4, 22), 2)
        bx = 32 + math.sin(t * 2 * math.pi + 1) * 4
        by = 8 + math.cos(t * 2 * math.pi) * 3
        d.ellipse([bx - 4, by - 2, bx - 1, by + 2], fill=(0, 0, 0, 220))
        d.ellipse([bx + 1, by - 2, bx + 4, by + 2], fill=(0, 0, 0, 220))
        d.ellipse([bx - 1, by - 1, bx + 1, by + 1], fill=(0, 0, 0, 255))

    elif pose_id == "peek-from-edge":
        rise = (math.sin(t * 2 * math.pi - math.pi / 2) + 1) / 2
        d.rectangle([0, 36, 43, 43], fill=(0, 0, 0, 255))
        hy = 40 - rise * 16
        head(d, 22, hy, 5)
        if rise > 0.25:
            limb(d, (22, hy + 5), (22, min(36, hy + 12)), 3)
            hand_y = 35
            limb(d, (22, hy + 8), (14, hand_y), 2)
            limb(d, (22, hy + 8), (30, hand_y), 2)

    else:
        head(d, 22, 14, 5)

    return im


def write_gif(frames: list[Image.Image], path: Path, duration_ms: int = 125) -> None:
    rgba_frames = [im.convert("RGBA") for im in frames]
    rgba_frames[0].save(
        path,
        save_all=True,
        append_images=rgba_frames[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
        transparency=0,
        optimize=False,
    )


def frames_to_webm(frame_dir: Path, out_webm: Path) -> None:
    pattern = str(frame_dir / "%02d.png")
    cmd = [
        "ffmpeg",
        "-y",
        "-framerate",
        str(FPS),
        "-i",
        pattern,
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-an",
        str(out_webm),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        return
    cmd2 = [
        "ffmpeg",
        "-y",
        "-framerate",
        str(FPS),
        "-i",
        pattern,
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuv420p",
        "-an",
        str(out_webm),
    ]
    r2 = subprocess.run(cmd2, capture_output=True, text=True)
    if r2.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{r.stderr}\n{r2.stderr}")


def main() -> int:
    ROOT.mkdir(parents=True, exist_ok=True)
    FRAMES.mkdir(parents=True, exist_ok=True)
    for pose_id, name_zh in POSES:
        pose_dir = FRAMES / pose_id
        pose_dir.mkdir(parents=True, exist_ok=True)
        imgs: list[Image.Image] = []
        for i in range(FRAMES_PER_POSE):
            t = i / FRAMES_PER_POSE
            im = draw_pose(pose_id, t)
            im.save(pose_dir / f"{i:02d}.png", "PNG")
            imgs.append(im)
        gif_path = ROOT / f"{pose_id}.gif"
        write_gif(imgs, gif_path)
        webm_path = ROOT / f"{pose_id}.webm"
        frames_to_webm(pose_dir, webm_path)
        print(
            f"OK {pose_id} ({name_zh}): "
            f"gif={gif_path.stat().st_size}B webm={webm_path.stat().st_size}B frames={len(imgs)}"
        )

    manifest = {
        "style": "flat-bw-pictogram",
        "iconSize": SIZE,
        "framesPerPose": FRAMES_PER_POSE,
        "fps": FPS,
        "poses": [
            {
                "id": p,
                "name": n,
                "gif": f"{p}.gif",
                "webm": f"{p}.webm",
                "framesDir": f"frames/{p}",
            }
            for p, n in POSES
        ],
    }
    (ROOT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("manifest written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
