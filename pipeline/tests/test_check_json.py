"""scripts/check_json.py: the refresh publish job's parse check on the artifact (broken files built in tmp_path)."""
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_json.py"


def run(directory):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), str(directory)], capture_output=True, text=True)


def test_valid_json_in_nested_folders_passes(tmp_path):
    (tmp_path / "entity").mkdir()
    (tmp_path / "a.json").write_text('{"a": 1}', "utf-8")
    (tmp_path / "entity" / "AD.json").write_text("[]", "utf-8")
    result = run(tmp_path)
    assert result.returncode == 0 and "2 files, 0 failed" in result.stdout


def test_truncated_json_fails_and_is_named(tmp_path):
    (tmp_path / "ok.json").write_text("{}", "utf-8")
    (tmp_path / "entity").mkdir()
    (tmp_path / "entity" / "AE.json").write_text('{"a": [1, 2', "utf-8")
    result = run(tmp_path)
    assert result.returncode == 1 and "entity/AE.json" in result.stderr


def test_non_json_content_and_bad_bytes_fail(tmp_path):
    (tmp_path / "text.json").write_text("#!/bin/sh\necho hi\n", "utf-8")
    (tmp_path / "bytes.json").write_bytes(b"\xff\xfe\x00")
    result = run(tmp_path)
    assert result.returncode == 1 and "text.json" in result.stderr and "bytes.json" in result.stderr


def test_empty_directory_and_missing_directory_fail(tmp_path):
    assert run(tmp_path).returncode == 1
    assert run(tmp_path / "missing").returncode == 1
