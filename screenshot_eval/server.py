#!/usr/bin/env python3
import base64
import mimetypes
import os
import json
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
BINARY = BASE_DIR / "bin" / "tokopuyo" / "tokopuyo.exe"
AMA_EVAL_BINARY = BASE_DIR / "bin" / "screenshot_eval" / "ama_eval.exe"

sys.path.insert(0, str(BASE_DIR))
from screen_reader.screen_reader import analyze_screen  # noqa: E402

AMA_COLORS = ["R", "Y", "G", "B"]
EDIT_COLORS = [".", "R", "Y", "G", "B", "P", "#"]


def _active_colors(player):
    colors = []
    for row in player.get("field", []):
        for cell in row:
            if cell in ("R", "Y", "G", "B", "P") and cell not in colors:
                colors.append(cell)

    pairs = []
    current = player.get("current_piece")
    if current:
        pairs.append(current)
    pairs.extend(player.get("queue") or [])
    for pair in pairs:
        if not pair:
            continue
        for cell in pair:
            if cell in ("R", "Y", "G", "B", "P") and cell not in colors:
                colors.append(cell)
    return colors


def _normalize_player(player):
    colors = _active_colors(player)
    if len(colors) > 4:
        raise ValueError(f"ama supports up to 4 colors, but found {len(colors)} colors: {''.join(colors)}")

    mapping = {src: AMA_COLORS[i] for i, src in enumerate(colors)}
    mapping.update({".": ".", "#": "#"})

    field = []
    for row in player.get("field", []):
        if len(row) != 6:
            raise ValueError("each field row must be exactly 6 cells")
        field.append("".join(mapping.get(cell, ".") for cell in row))

    if len(field) != 13:
        raise ValueError("field must contain exactly 13 rows")

    queue = []
    current = player.get("current_piece")
    if current:
        queue.append(current)
    queue.extend(player.get("queue") or [])

    normalized_queue = []
    for pair in queue:
        if not pair or len(pair) != 2:
            continue
        a, b = pair
        if a not in mapping or b not in mapping or a in (".", "#") or b in (".", "#"):
            continue
        normalized_queue.append([mapping[a], mapping[b]])

    if len(normalized_queue) < 2:
        raise ValueError("current piece plus at least one next pair is required")

    return field, normalized_queue, mapping


def _call_tokopuyo(field, queue, options):
    payload = {
        "field": field,
        "queue": queue,
        "options": options,
    }
    result = subprocess.run(
        [str(BINARY)],
        input=json.dumps(payload) + "\n",
        capture_output=True,
        text=True,
        cwd=str(BASE_DIR),
        timeout=int(options.get("timeout_sec", 120)),
    )
    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError(result.stderr.strip() or "tokopuyo produced no output")
    data = json.loads(stdout)
    if data.get("error"):
        raise RuntimeError(data["error"])
    return data


def _call_ama_eval(players, options):
    payload = {
        "p1": players["p1"],
        "p2": players["p2"],
        "options": {
            "target_point": int(options.get("target_point", 70)),
            "trigger": int(options.get("trigger", 100000)),
            "width": int(options.get("width", 500)),
            "depth": int(options.get("depth", 24)),
            "stretch": bool(options.get("stretch", True)),
        },
    }
    result = subprocess.run(
        [str(AMA_EVAL_BINARY)],
        input=json.dumps(payload) + "\n",
        capture_output=True,
        text=True,
        cwd=str(BASE_DIR),
        timeout=int(options.get("timeout_sec", 120)),
    )
    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError(result.stderr.strip() or "ama_eval produced no output")
    data = json.loads(stdout)
    if data.get("error"):
        raise RuntimeError(data["error"])
    return data


def _visible_garbage(player):
    try:
        return max(0, int(player.get("garbage", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _nested(data, *keys, default=None):
    cur = data
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def _action_send(action):
    if not isinstance(action, dict):
        return 0
    attack = action.get("attack") or {}
    return _as_int(attack.get("send_total", attack.get("send", 0)))


def _summary_send(summary):
    if not isinstance(summary, dict):
        return 0
    return _action_send(summary.get("best"))


def _build_score(side):
    build = _nested(side, "strategy", "build_quality", default={}) or {}
    beam = _nested(build, "beam_build", "best", "ama_eval")
    if beam is not None:
        return _as_int(beam)
    fast = _nested(build, "fast_build", "best", "value")
    return _as_int(fast)


def _side_battle_metrics(side):
    strategy = side.get("strategy") or {}
    incoming = strategy.get("incoming") or {}
    offense = strategy.get("offense") or {}
    pending = side.get("pending") or {}

    response_candidates = [
        _summary_send(incoming.get("all_clear_return")),
        _summary_send(_nested(incoming, "immediate_main_return", "candidates", default={})),
        _summary_send(incoming.get("syncro_return")),
        _summary_send(incoming.get("small_return")),
        _summary_send(incoming.get("main_return")),
        _summary_send(incoming.get("desperate_return")),
    ]
    response_candidates.append(_as_int(offense.get("attack_max_send_total", 0)))
    for action in side.get("self_attack_candidates") or []:
        response_candidates.append(_action_send(action))

    incoming_count = _as_int(pending.get("incoming", 0))
    accept_limit = _as_int(incoming.get("accept_limit", _nested(side, "defense", "accept_limit", default=0)))
    response_send = max(response_candidates or [0])
    survival_margin = accept_limit + response_send - incoming_count
    build_score = _build_score(side)
    attack_max = _as_int(offense.get("attack_max_send_total", 0))

    if incoming_count > 0 and survival_margin < 0:
        status = "critical"
    elif incoming_count > accept_limit:
        status = "counter_required"
    elif incoming_count > 0:
        status = "can_accept"
    else:
        status = "stable"

    return {
        "incoming": incoming_count,
        "accept_limit": accept_limit,
        "max_response_send": response_send,
        "survival_margin": survival_margin,
        "attack_max_send": attack_max,
        "build_score": build_score,
        "status": status,
    }


def _estimate_battle(strategy):
    if not isinstance(strategy, dict):
        return None

    metrics = {
        "p1": _side_battle_metrics(strategy.get("p1") or {}),
        "p2": _side_battle_metrics(strategy.get("p2") or {}),
    }
    p1 = metrics["p1"]
    p2 = metrics["p2"]

    p1_dead = p1["status"] == "critical"
    p2_dead = p2["status"] == "critical"
    margin_diff = p1["survival_margin"] - p2["survival_margin"]
    attack_diff = p1["attack_max_send"] - p2["attack_max_send"]
    build_diff = p1["build_score"] - p2["build_score"]

    if p1_dead and not p2_dead:
        leader = "p2"
        score = -100000 + margin_diff * 100
        reason = f"P1は受け+最大返しが頭上おじゃまに{abs(p1['survival_margin'])}個不足"
    elif p2_dead and not p1_dead:
        leader = "p1"
        score = 100000 + margin_diff * 100
        reason = f"P2は受け+最大返しが頭上おじゃまに{abs(p2['survival_margin'])}個不足"
    elif p1_dead and p2_dead:
        score = margin_diff * 100 + attack_diff * 10
        leader = "p1" if score > 0 else "p2" if score < 0 else "even"
        reason = "双方が致死級のおじゃまを抱えているため、生存余力の差を優先"
    else:
        score = margin_diff * 100 + attack_diff * 10 + build_diff / 100
        leader = "p1" if score > 250 else "p2" if score < -250 else "even"
        reason = (
            f"生存余力差 {margin_diff}個、最大火力差 {attack_diff}個、"
            f"積み評価差 {build_diff}"
        )

    confidence = "high" if abs(score) >= 5000 or p1_dead != p2_dead else "medium" if abs(score) >= 1000 else "low"
    return {
        "leader": leader,
        "score": int(score),
        "confidence": confidence,
        "players": metrics,
        "reason": reason,
        "note": "heuristic battle estimate; survival against visible garbage is prioritized over build quality",
    }


def evaluate_payload(data):
    raw_options = data.get("options") or {}
    options = {
        "width": int(raw_options.get("width", 500)),
        "depth": int(raw_options.get("depth", 24)),
        "weights": raw_options.get("weights", "build"),
        "no_fire": bool(raw_options.get("no_fire", False)),
        "target_point": max(1, int(raw_options.get("target_point", 70))),
        "trigger": max(1, int(raw_options.get("trigger", 100000))),
        "timeout_sec": max(1, int(raw_options.get("timeout_sec", 60))),
        "stretch": bool(raw_options.get("stretch", True)),
    }

    response = {"players": {}, "warnings": []}
    best_scores = {}
    normalized_players = {}

    for player_key in ("p1", "p2"):
        try:
            player = data[player_key]
            field, queue, mapping = _normalize_player(player)
            normalized_players[player_key] = {
                "field": field,
                "queue": queue,
                "garbage": _visible_garbage(player),
            }
        except Exception as exc:
            response["players"][player_key] = {"error": str(exc)}
            best_scores[player_key] = None
            continue

        try:
            result = _call_tokopuyo(field, queue, options)
            candidates = result.get("candidates", [])
            best_scores[player_key] = candidates[0]["expected_score"] if candidates else 0
            response["players"][player_key] = {
                "candidates": candidates,
                "elapsed_ms": result.get("elapsed_ms"),
                "color_map": mapping,
            }
        except Exception as exc:
            response["players"][player_key] = {
                "error": str(exc),
                "color_map": mapping,
            }
            best_scores[player_key] = None

    p1 = best_scores.get("p1")
    p2 = best_scores.get("p2")
    if p1 is not None and p2 is not None:
        response["eval"] = {
            "p1_minus_p2": p1 - p2,
            "leader": "p1" if p1 > p2 else "p2" if p2 > p1 else "even",
            "note": "temporary single-player build-score difference",
        }
    else:
        response["eval"] = None

    if set(normalized_players) == {"p1", "p2"}:
        if AMA_EVAL_BINARY.exists():
            try:
                response["strategy"] = _call_ama_eval(normalized_players, options)
                response["battle_eval"] = _estimate_battle(response["strategy"])
                if response["battle_eval"]:
                    for key in ("p1", "p2"):
                        response["strategy"][key]["battle"] = response["battle_eval"]["players"][key]
            except Exception as exc:
                response["strategy"] = None
                response["battle_eval"] = None
                response["warnings"].append(f"ama strategy diagnostics failed: {exc}")
        else:
            response["strategy"] = None
            response["battle_eval"] = None
            response["warnings"].append("ama_eval.exe is not built; run `make ama_eval`")
    else:
        response["strategy"] = None
        response["battle_eval"] = None

    return response


def analyze_payload(data):
    encoded = data.get("image_base64")
    if not encoded:
        raise ValueError("missing image_base64")
    if "," in encoded:
        encoded = encoded.split(",", 1)[1]

    filename = data.get("filename") or "upload.png"
    suffix = Path(filename).suffix or ".png"
    raw = base64.b64decode(encoded)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(raw)
        tmp.flush()
        return analyze_screen(tmp.name, debug=False)


class Handler(BaseHTTPRequestHandler):
    server_version = "ScreenshotEval/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" %
                         (self.address_string(), self.log_date_time_string(), fmt % args))

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise ValueError("empty request body")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            data = self._read_json()
            if self.path == "/api/analyze":
                self._send_json(analyze_payload(data))
            elif self.path == "/api/evaluate":
                self._send_json(evaluate_payload(data))
            else:
                self._send_json({"error": "not found"}, 404)
        except json.JSONDecodeError as exc:
            self._send_json({"error": f"invalid JSON: {exc}"}, 400)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 5001))
    print(f"http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
