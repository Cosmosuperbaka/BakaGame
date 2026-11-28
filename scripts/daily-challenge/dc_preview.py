#!/usr/bin/env python3
"""每日挑战试听样品：原曲 → 分离人声与低音 → 转成音符 → 用钢琴重新演奏 → 分段 + 本地试听页。

素材里不含任何原曲音频（揭晓答案时的原曲对照除外），只用于评估「分层揭示」玩法的观感。

用法：
    python dc_preview.py --sf2 GeneralUser-GS.sf2 --game game-large-onnx --out 输出目录 歌1.mp3 歌2.flac::ja ...
依赖：torch、demucs、librosa、soundfile、numpy、tinysoundfont（只用离线渲染，不需要声卡）、onnxruntime。

人声旋律默认用 GAME（openvpi 的歌声转音符模型，ONNX 版）转写，逐字切分音符；
不给 --game 时退回 pYIN 逐帧音高，漏音明显更多，只作对照。
歌曲路径后可加 ::zh / ::ja / ::en / ::yue 指定演唱语言，帮助 GAME 按字切分；不加则用通用模式。
注意：GAME 预训练权重是 CC BY-NC-SA 4.0（非商用），只适合内部评估，上线前须换成可商用的权重或自训模型。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import tinysoundfont
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

SR = 44100
MELODY_STAGES = [1, 2, 4, 7, 11, 16]  # 旋律分段秒数，参考 Heardle
CLIP_SECONDS = 16.0
RHYTHM_SECONDS = 10.0
CROP_SECONDS = 26.0  # 每个候选窗口送去分离的长度，留出对齐乐句起点的余量
PIANO, WOODBLOCK = 0, 115  # GM 音色号（0 起算）
LANGUAGE_SUFFIXES = ("zh", "ja", "en", "yue")


def log(*parts: object) -> None:
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# ---------- 选段 ----------

def candidate_starts(mono: np.ndarray, count: int = 4, window: float = 22.0) -> list[float]:
    """按整体响度挑候选窗口：副歌通常最响，限制在全曲 15%～80% 之间，避开前奏与尾奏。"""
    duration = len(mono) / SR
    if duration <= window + 2:
        return [0.0]
    hop = SR // 2
    rms = librosa.feature.rms(y=mono, frame_length=hop * 2, hop_length=hop)[0]
    span = int(window / 0.5)
    energy = np.convolve(rms**2, np.ones(span), "valid")
    starts = np.arange(len(energy)) * 0.5
    lo, hi = duration * 0.15, max(duration * 0.80 - window, duration * 0.15)
    allowed = (starts >= lo) & (starts <= hi)
    if not allowed.any():
        allowed[:] = True
    chosen: list[float] = []
    for index in np.argsort(-np.where(allowed, energy, -1.0)):
        if not allowed[index]:
            break
        start = float(starts[index])
        if all(abs(start - other) >= window * 0.8 for other in chosen):
            chosen.append(start)
        if len(chosen) >= count:
            break
    return chosen


# ---------- 分离 ----------

class Separator:
    def __init__(self, name: str = "htdemucs") -> None:
        self.model = get_model(name)
        self.model.eval()

    def __call__(self, stereo: np.ndarray) -> dict[str, np.ndarray]:
        wav = torch.from_numpy(np.ascontiguousarray(stereo)).float()
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        with torch.no_grad():
            out = apply_model(
                self.model, ((wav - mean) / std)[None], device="cpu", split=True,
                overlap=0.25, progress=False, num_workers=0,
            )[0]
        out = out * std + mean
        return {name: out[i].numpy() for i, name in enumerate(self.model.sources)}


class Game:
    """GAME 歌声转音符（ONNX）。推理流程照官方 ONNX.md：编码 → D3PM 迭代切分音符边界 → 估计每个音符的音高。"""

    def __init__(self, model_dir: Path) -> None:
        import onnxruntime as ort

        self.config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        self.sr = int(self.config.get("samplerate", SR))
        self.languages: dict[str, int] = self.config.get("languages", {})
        options = ort.SessionOptions()
        options.log_severity_level = 3

        def load(name: str):
            # 同样读成字节：避免 Windows 中文路径问题
            return ort.InferenceSession((model_dir / f"{name}.onnx").read_bytes(), options,
                                        providers=["CPUExecutionProvider"])

        self.encoder, self.segmenter, self.estimator = load("encoder"), load("segmenter"), load("estimator")
        self.dur2bd, self.bd2dur = load("dur2bd"), load("bd2dur")
        self.segmenter_inputs = {i.name for i in self.segmenter.get_inputs()}

    def chunk(self, wav: np.ndarray, language: int, steps: int = 8, boundary_threshold: float = 0.2,
              radius: int = 2, presence_threshold: float = 0.2) -> list[tuple[float, float, float]]:
        duration = np.array([len(wav) / self.sr], dtype=np.float32)
        x_seg, x_est, mask_t = self.encoder.run(
            None, {"waveform": wav[None].astype(np.float32), "duration": duration})
        known = self.dur2bd.run(None, {"durations": duration[None], "maskT": mask_t})[0]
        boundaries = known
        for step in range(steps):
            feed = {
                "x_seg": x_seg, "known_boundaries": known, "maskT": mask_t,
                "threshold": np.array(boundary_threshold, dtype=np.float32),
                "radius": np.array(radius, dtype=np.int64),
            }
            if "language" in self.segmenter_inputs:
                feed["language"] = np.array([language], dtype=np.int64)
            if "prev_boundaries" in self.segmenter_inputs:
                feed["prev_boundaries"] = boundaries
                feed["t"] = np.array([step / steps], dtype=np.float32)
            boundaries = self.segmenter.run(None, feed)[0]
        durations, mask_n = self.bd2dur.run(None, {"boundaries": boundaries, "maskT": mask_t})
        presence, scores = self.estimator.run(None, {
            "x_est": x_est, "boundaries": boundaries, "maskT": mask_t, "maskN": mask_n,
            "threshold": np.array(presence_threshold, dtype=np.float32),
        })
        notes, t = [], 0.0
        valid = mask_n[0].astype(bool)
        for d, present, score in zip(durations[0][valid], presence[0][valid], scores[0][valid]):
            if present:
                notes.append((t, t + float(d), float(score)))
            t += float(d)
        return notes

    def __call__(self, vocals: np.ndarray, language: str | None) -> list[dict]:
        """vocals：44.1 kHz 单声道人声干声。按静音切成短块分别推理（切分器开销随长度超线性增长）。"""
        lang_id = self.languages.get(language or "", 0)
        hop = self.sr // 100
        db = to_db(vocals, hop, 2048)
        silent = db < max(-40.0, float(db.max()) - 45.0)
        notes: list[tuple[float, float, float]] = []
        for a, b in split_on_silence(silent, min_rest=20, max_len=1500):
            if (~silent[a:b]).sum() < 10:
                continue
            for start, end, score in self.chunk(vocals[a * hop: b * hop], lang_id):
                notes.append((start + a / 100, end + a / 100, score))
        if not notes:
            return []
        # 去整体音准偏差：音高小数部分按时长加权求圆周平均
        weights = np.array([e - s for s, e, _ in notes])
        frac = np.array([p - round(p) for _, _, p in notes])
        tuning = float(np.angle(np.sum(weights * np.exp(2j * np.pi * frac))) / (2 * np.pi))
        result = []
        for start, end, score in notes:
            if end - start < 0.05:
                continue
            a, b = int(start * 100), max(int(start * 100) + 1, int(end * 100))
            result.append({"start": round(start, 3), "end": round(end, 3),
                           "pitch": int(round(score - tuning)), "db": float(np.median(db[a:b]))})
        return result


def split_on_silence(silent: np.ndarray, min_rest: int, max_len: int) -> list[tuple[int, int]]:
    """在至少 min_rest 帧的静音中点切开；超过 max_len 帧的块再在最安静处对半切。"""
    cuts, i, n = [0], 0, len(silent)
    while i < n:
        if silent[i]:
            j = i
            while j < n and silent[j]:
                j += 1
            if j - i >= min_rest and 0 < i and j < n:
                cuts.append((i + j) // 2)
            i = j
        else:
            i += 1
    cuts.append(n)
    spans: list[tuple[int, int]] = []
    for a, b in zip(cuts, cuts[1:]):
        stack = [(a, b)]
        while stack:
            x, y = stack.pop()
            if y - x > max_len:
                mid = x + max_len // 4 + int(np.argmax(silent[x + max_len // 4: y - max_len // 4]))
                stack += [(mid, y), (x, mid)]
            else:
                spans.append((x, y))
    return sorted(spans)


def to_db(x: np.ndarray, hop: int, frame: int) -> np.ndarray:
    rms = librosa.feature.rms(y=x, frame_length=frame, hop_length=hop, center=True)[0]
    return 20 * np.log10(rms + 1e-9)


# ---------- 转音符 ----------

def track_notes(
    y: np.ndarray, sr: int, *, fmin: float, fmax: float, frame: int, hop: int,
    gate_below_peak_db: float, min_dur: float, split_onsets: bool, glides: bool = True,
    onset_delta: float = 0.12,
) -> list[dict]:
    """pYIN 取音高 → 去整体音准偏差 → 众数滤波压掉颤音和滑音 → 同音高连续段即一个音符。

    发声与否只用 pYIN 自己的判定加一道音量门限；再按发声概率卡一道会扔掉一半以上的演唱。
    """
    f0, _, _ = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=frame, hop_length=hop)
    db = to_db(y, hop, frame)[: len(f0)]
    hop_t = hop / sr
    midi = np.where(np.isfinite(f0), 69 + 12 * np.log2(np.where(np.isfinite(f0), f0, 440) / 440.0), np.nan)
    voiced = np.isfinite(midi) & (db > max(db.max() + gate_below_peak_db, -55))
    if voiced.sum() < 10:
        return []
    frac = midi[voiced] - np.round(midi[voiced])
    tuning = float(np.angle(np.mean(np.exp(2j * np.pi * frac))) / (2 * np.pi))
    q = np.full(len(midi), -1, dtype=int)
    q[voiced] = np.round(midi[voiced] - tuning).astype(int)
    smooth = q.copy()
    for i in np.flatnonzero(q >= 0):
        window = q[max(0, i - 4): i + 5]
        window = window[window >= 0]
        values, counts = np.unique(window, return_counts=True)
        smooth[i] = values[np.argmax(counts)]

    segments: list[list[float]] = []
    i, n = 0, len(smooth)
    while i < n:
        if smooth[i] < 0:
            i += 1
            continue
        j = i
        while j + 1 < n and smooth[j + 1] == smooth[i]:
            j += 1
        segments.append([i * hop_t, (j + 1) * hop_t, int(smooth[i])])
        i = j + 1

    merged: list[list[float]] = []
    for seg in segments:  # 同音高、间隔很短的两段是同一个音被清辅音打断
        if merged and merged[-1][2] == seg[2] and seg[0] - merged[-1][1] < 0.06:
            merged[-1][1] = seg[1]
        else:
            merged.append(seg)

    if glides:
        merged = absorb_glides(merged)

    if split_onsets:  # 同音高的连续字靠起音切开
        onsets = librosa.onset.onset_detect(
            y=y, sr=sr, hop_length=hop, backtrack=True, units="time", delta=onset_delta
        )
        split: list[list[float]] = []
        for start, end, pitch in merged:
            cuts = [o for o in onsets if start + min_dur < o < end - min_dur]
            edges = [start, *cuts, end]
            split += [[a, b, pitch] for a, b in zip(edges, edges[1:])]
        merged = split

    notes = [s for s in merged if s[1] - s[0] >= min_dur]
    pitches = [s[2] for s in notes]
    for k, note in enumerate(notes):  # 修八度误判：与前后邻居都差很远的音挪回最近的八度
        neighbours = pitches[max(0, k - 2): k] + pitches[k + 1: k + 3]
        if neighbours:
            ref = float(np.median(neighbours))
            while note[2] - ref >= 9:
                note[2] -= 12
            while ref - note[2] >= 9:
                note[2] += 12

    result = []
    for start, end, pitch in notes:
        a, b = int(start / hop_t), max(int(start / hop_t) + 1, int(end / hop_t))
        loud = float(np.median(db[a:b]))
        result.append({"start": round(start, 3), "end": round(end, 3), "pitch": int(pitch), "db": loud})
    return result


def absorb_glides(segments: list[list[float]], max_len: float = 0.13, gap: float = 0.04) -> list[list[float]]:
    """滑音（上滑起音、下滑收尾）会被量化成一串很短的半音阶，钢琴弹出来像跑了一段音阶。

    一串紧挨着的短段，若连同前后的稳定音一起单调上行或下行，就视为滑音：
    优先并进后一个稳定音（歌手的上滑多是这个字的起音），没有后音时并进前一个音的尾巴。
    """
    segs = [list(s) for s in segments]
    out: list[list[float]] = []
    i, n = 0, len(segs)
    while i < n:
        if segs[i][1] - segs[i][0] >= max_len:
            out.append(segs[i])
            i += 1
            continue
        j = i
        while j + 1 < n and segs[j + 1][1] - segs[j + 1][0] < max_len and segs[j + 1][0] - segs[j][1] < gap:
            j += 1
        run = segs[i: j + 1]
        prev = out[-1] if out and run[0][0] - out[-1][1] < gap else None
        nxt = segs[j + 1] if j + 1 < n and segs[j + 1][0] - run[-1][1] < gap else None
        path = ([prev[2]] if prev else []) + [s[2] for s in run] + ([nxt[2]] if nxt else [])
        steps = np.diff(path)
        monotonic = len(path) >= 3 and (bool(np.all(steps > 0)) or bool(np.all(steps < 0)))
        if monotonic and nxt is not None:
            nxt[0] = run[0][0]
        elif monotonic and prev is not None:
            prev[1] = run[-1][1]
        else:
            out.extend(run)
        i = j + 1
    return out


def shift_into(notes: list[dict], lo: int, hi: int) -> None:
    """整体按八度移到指定音区：旋律放到钢琴右手的明亮音区，低音放到左手。"""
    if not notes:
        return
    median = float(np.median([n["pitch"] for n in notes]))
    shift = 0
    while median + shift < lo:
        shift += 12
    while median + shift > hi:
        shift -= 12
    for n in notes:
        n["pitch"] += shift


def velocities(notes: list[dict], lo: int, hi: int) -> None:
    if not notes:
        return
    dbs = np.array([n["db"] for n in notes])
    span = max(dbs.max() - dbs.min(), 1e-6)
    for n in notes:
        n["vel"] = int(lo + (n["db"] - dbs.min()) / span * (hi - lo))


# ---------- 渲染 ----------

class Piano:
    def __init__(self, sf2: Path) -> None:
        # 读成字节再交给合成器：TinySoundFont 在 Windows 上用 ANSI 路径打开文件，中文路径会失败
        self.sf2 = Path(sf2).read_bytes()

    def render(self, parts: list[tuple[int, list[dict]]], seconds: float, tail: float = 0.8) -> np.ndarray:
        """parts：(GM 音色号, 音符)；音符的起止已换算到片段内的秒数。"""
        synth = tinysoundfont.Synth(samplerate=SR)
        sfid = synth.sfload(self.sf2)
        events: list[tuple[float, int, int, int, int]] = []  # (时刻, 先关后开, 通道, 音高, 力度)
        for channel, (program, notes) in enumerate(parts):
            synth.program_select(channel, sfid, 0, program)
            for n in notes:
                events.append((n["start"], 1, channel, n["pitch"], n.get("vel", 90)))
                events.append((n["end"], 0, channel, n["pitch"], 0))
        events.sort()
        chunks, cursor = [], 0
        total = int((seconds + tail) * SR)
        for at, is_on, channel, pitch, vel in events:
            sample = min(int(at * SR), total)
            if sample > cursor:
                chunks.append(np.frombuffer(synth.generate(sample - cursor), dtype=np.float32).copy())
                cursor = sample
            if is_on:
                synth.noteoff(channel, pitch)
                synth.noteon(channel, pitch, vel)
            else:
                synth.noteoff(channel, pitch)
        if total > cursor:
            chunks.append(np.frombuffer(synth.generate(total - cursor), dtype=np.float32).copy())
        audio = np.concatenate(chunks).reshape(-1, 2)
        fade = int(tail * SR)
        audio[-fade:] *= np.linspace(1, 0, fade)[:, None]
        return audio


def legato(notes: list[dict], max_gap: float = 0.15) -> list[dict]:
    out = [dict(n) for n in notes]
    for a, b in zip(out, out[1:]):
        if 0 <= b["start"] - a["end"] < max_gap:
            a["end"] = b["start"]
    return out


def window(notes: list[dict], start: float, seconds: float) -> list[dict]:
    """取片段内的音符，起止换算成片段内时刻，跨过片段末尾的音在末尾松开。"""
    out = []
    for n in notes:
        if n["end"] <= start or n["start"] >= start + seconds:
            continue
        out.append({**n, "start": max(0.0, n["start"] - start), "end": min(seconds, n["end"] - start)})
    return out


def loudness(audio: np.ndarray, target_db: float = -18.0) -> np.ndarray:
    rms = float(np.sqrt(np.mean(audio**2))) + 1e-9
    audio = audio * (10 ** (target_db / 20) / rms)
    peak = float(np.abs(audio).max())
    return audio / peak * 0.95 if peak > 0.95 else audio


def write_audio(path_stem: Path, audio: np.ndarray) -> str:
    for ext, fmt in ((".mp3", "MP3"), (".ogg", "OGG"), (".wav", "WAV")):
        try:
            sf.write(str(path_stem) + ext, audio, SR, format=fmt)
            return path_stem.name + ext
        except Exception:  # 旧版 libsndfile 不支持 MP3 时依次退回
            continue
    raise RuntimeError(f"无法写出音频 {path_stem}")


# ---------- 单首歌 ----------

def process(path: Path, language: str | None, out_dir: Path, sep: Separator, piano: Piano,
            game: Game | None) -> dict:
    log("读取", path.name, f"（{language}）" if language else "")
    audio, _ = librosa.load(str(path), sr=SR, mono=False)
    stereo = np.vstack([audio, audio]) if audio.ndim == 1 else audio[:2]
    mono = stereo.mean(0)
    duration = len(mono) / SR

    best = None
    for start in candidate_starts(mono):
        a = max(0.0, start - 2.0)
        b = min(duration, a + CROP_SECONDS)
        log(f"  分离 {a:.0f}s～{b:.0f}s")
        stems = sep(stereo[:, int(a * SR): int(b * SR)])
        vocals = librosa.resample(stems["vocals"].mean(0), orig_sr=SR, target_sr=22050)
        mix = librosa.resample(stereo[:, int(a * SR): int(b * SR)].mean(0), orig_sr=SR, target_sr=22050)
        vdb, mdb = to_db(vocals, 256, 2048), to_db(mix, 256, 2048)
        # 人声比整体混音低不到 15 dB、且本身不是近乎静音，才算这一帧有人在唱
        active = float(((vdb > mdb - 15) & (vdb > -50)).mean())
        log(f"  人声占比 {active:.0%}")
        if best is None or active > best[0]:
            best = (active, a, b, stems, vocals)
        if active >= 0.45:
            break
    assert best is not None
    active, crop_a, crop_b, stems, vocals = best

    if game is not None:
        log("  转写人声旋律（GAME）")
        melody = game(stems["vocals"].mean(0), language)
    else:
        log("  转写人声旋律（pYIN）")
        melody = track_notes(
            vocals, 22050, fmin=80, fmax=1100, frame=2048, hop=256,
            gate_below_peak_db=-32, min_dur=0.08, split_onsets=True,
        )
    log("  转写低音")
    bass_y = librosa.resample(stems["bass"].mean(0), orig_sr=SR, target_sr=11025)
    # 低音几乎不滑音，但常在同一个音上连弹八分音符，所以不并滑音、按起音切开
    bass = track_notes(
        bass_y, 11025, fmin=30, fmax=320, frame=2048, hop=128,
        gate_below_peak_db=-28, min_dur=0.1, split_onsets=True, glides=False, onset_delta=0.2,
    )
    if len(melody) < 8:
        raise RuntimeError(f"人声旋律只转出 {len(melody)} 个音，可能是纯音乐或人声太弱")

    # 片段从一个乐句的开头起：前面至少空 0.3 秒的音符，且留够 16 秒
    latest = max(0.0, (crop_b - crop_a) - CLIP_SECONDS)
    clip = melody[0]["start"]
    for prev, cur in zip(melody, melody[1:]):
        if 0.8 <= cur["start"] <= latest and cur["start"] - prev["end"] >= 0.3:
            clip = cur["start"]
            break
    clip = max(0.0, min(clip - 0.05, latest))

    shift_into(melody, 66, 78)
    shift_into(bass, 38, 50)
    velocities(melody, 72, 108)
    velocities(bass, 48, 68)
    melody = legato(melody)
    bass = legato(bass, 0.1)

    # 目录名不带歌名，免得翻文件夹就剧透
    q_dir = out_dir / ("q_" + hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:8])
    q_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}

    hits = [
        {"start": n["start"], "end": n["start"] + 0.12, "pitch": 76,
         "vel": 110 if i == 0 or n["start"] - melody[i - 1]["end"] > 0.25 else 80}
        for i, n in enumerate(melody)
    ]
    rhythm = piano.render([(WOODBLOCK, window(hits, clip, RHYTHM_SECONDS))], RHYTHM_SECONDS)
    files["rhythm"] = write_audio(q_dir / "rhythm", rhythm / max(float(np.abs(rhythm).max()), 1e-9) * 0.9)
    for seconds in MELODY_STAGES:
        part = piano.render([(PIANO, window(melody, clip, seconds))], seconds, tail=0.6)
        files[f"m{seconds}"] = write_audio(q_dir / f"melody_{seconds:02d}s", loudness(part))
    arrangement = piano.render(
        [(PIANO, window(melody, clip, CLIP_SECONDS)), (PIANO, window(bass, clip, CLIP_SECONDS))],
        CLIP_SECONDS,
    )
    files["arr"] = write_audio(q_dir / "piano_with_bass", loudness(arrangement))
    s = int((crop_a + clip) * SR)
    original = stereo[:, s: s + int(CLIP_SECONDS * SR)].T.copy()
    fade = int(0.8 * SR)
    original[-fade:] *= np.linspace(1, 0, fade)[:, None]
    files["orig"] = write_audio(q_dir / "original", loudness(original))

    in_clip = window(melody, clip, CLIP_SECONDS)
    info = {
        "title": path.stem,
        "transcriber": "game" if game is not None else "pyin",
        "dir": q_dir.name,
        "files": files,
        "clip_start_s": round(crop_a + clip, 2),
        "vocal_activity": round(active, 2),
        "melody_notes_in_clip": len(in_clip),
        "bass_notes_in_clip": len(window(bass, clip, CLIP_SECONDS)),
        "melody_range": [min(n["pitch"] for n in in_clip), max(n["pitch"] for n in in_clip)] if in_clip else None,
    }
    (q_dir / "notes.json").write_text(
        json.dumps({"melody": in_clip, "bass": window(bass, clip, CLIP_SECONDS), **info}, ensure_ascii=False),
        encoding="utf-8",
    )
    log("  完成", json.dumps({k: v for k, v in info.items() if k != "files"}, ensure_ascii=False))
    return info


# ---------- 试听页 ----------

PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>每日挑战试听</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--quiet:#6b6b70;--line:#e3e1dc;--accent:#3b6ef5;--good:#1f9d55}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1e1e21;--ink:#ececef;--quiet:#9a9aa2;--line:#2e2e33;--accent:#7b9bff;--good:#4cc38a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}.lead{color:var(--quiet);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 16px}
.card h2{font-size:17px;margin:0 0 12px;display:flex;justify-content:space-between;align-items:baseline}
.card h2 small{font-weight:400;color:var(--quiet);font-size:13px}
.steps{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
.steps li{font-size:13px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--quiet)}
.steps li.open{color:var(--ink)}.steps li.now{border-color:var(--accent);color:var(--accent);font-weight:600}
audio{width:100%;margin:4px 0 12px}.row{display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);padding:7px 14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.45;cursor:default}
.answer{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}.answer b{color:var(--good)}
.answer audio{margin-bottom:0}.hint{color:var(--quiet);font-size:13px;margin:0 0 8px}
</style></head><body><main>
<h1>每日挑战试听</h1>
<p class="lead">每题先听只按字敲出的节奏，再逐段放长钢琴旋律，最后是旋律加低音的钢琴版。听出来了就点「揭晓答案」，和原曲对照。</p>
<div id="list"></div>
</main>
<script>
const QUESTIONS = __DATA__;
const STEPS = [["rhythm","节奏"],["m1","旋律 1 秒"],["m2","2 秒"],["m4","4 秒"],["m7","7 秒"],["m11","11 秒"],["m16","16 秒"],["arr","加低音"]];
const list = document.getElementById("list");
QUESTIONS.forEach((q, qi) => {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<h2>第 ${qi + 1} 题<small>片段从原曲 ${q.clip_start_s} 秒起</small></h2>
    <ul class="steps">${STEPS.map(([, label]) => `<li>${label}</li>`).join("")}</ul>
    <p class="hint"></p><audio controls preload="none"></audio>
    <div class="row"><button class="primary next">下一段</button><button class="reveal">揭晓答案</button></div>
    <div class="answer" hidden><p>答案：<b></b></p><p class="hint">原曲同一位置的 16 秒：</p><audio controls preload="none"></audio></div>`;
  const chips = card.querySelectorAll(".steps li");
  const player = card.querySelector("audio");
  const hint = card.querySelector(".hint");
  const next = card.querySelector(".next");
  let step = 0;
  const show = (autoplay) => {
    chips.forEach((c, i) => { c.className = i < step ? "open" : i === step ? "now" : ""; });
    player.src = `${q.dir}/${q.files[STEPS[step][0]]}`;
    hint.textContent = `当前：${STEPS[step][1]}（第 ${step + 1} / ${STEPS.length} 段）`;
    next.disabled = step === STEPS.length - 1;
    if (autoplay) player.play().catch(() => {});
  };
  next.onclick = () => { if (step < STEPS.length - 1) { step += 1; show(true); } };
  chips.forEach((chip, i) => chip.onclick = () => { if (i <= step) { player.src = `${q.dir}/${q.files[STEPS[i][0]]}`; player.play().catch(() => {}); } });
  card.querySelector(".reveal").onclick = () => {
    const box = card.querySelector(".answer");
    box.hidden = false;
    box.querySelector("b").textContent = q.title;
    box.querySelector("audio").src = `${q.dir}/${q.files.orig}`;
  };
  show(false);
  list.appendChild(card);
});
</script></body></html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("songs", nargs="+", help="歌曲路径，可加 ::zh / ::ja / ::en / ::yue 指定演唱语言")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--sf2", type=Path, required=True)
    parser.add_argument("--game", type=Path, default=None, help="GAME ONNX 模型目录（含 config.json 与 5 个 .onnx）")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()
    torch.set_num_threads(max(1, (os.cpu_count() or 2)))
    args.out.mkdir(parents=True, exist_ok=True)
    sep, piano = Separator(), Piano(args.sf2)
    game = Game(args.game) if args.game else None
    done, failed = [], []
    for raw in args.songs:
        name, _, suffix = raw.rpartition("::")
        song, language = (Path(name), suffix) if name and suffix in LANGUAGE_SUFFIXES else (Path(raw), None)
        try:
            done.append(process(song, language, args.out, sep, piano, game))
        except Exception as error:  # 单首失败不影响其它
            log("  跳过", song.name, "：", error)
            failed.append({"song": song.name, "error": str(error)})
    random.Random(args.seed).shuffle(done)
    data = json.dumps(done, ensure_ascii=False).replace("</", "<\\/")
    (args.out / "index.html").write_text(PAGE.replace("__DATA__", data), encoding="utf-8")
    (args.out / "summary.json").write_text(
        json.dumps({"ok": done, "failed": failed}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log(f"完成 {len(done)} 首，失败 {len(failed)} 首 → {args.out / 'index.html'}")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
