import ast
import json
import signal
import socket
import sys
from pathlib import Path


BLOCKED_IMPORTS = {
    "ctypes",
    "ftplib",
    "http",
    "os",
    "pathlib2",
    "requests",
    "shutil",
    "socket",
    "subprocess",
    "sys",
    "urllib",
}

BLOCKED_CALLS = {
    "__import__",
    "compile",
    "eval",
    "exec",
    "exit",
    "globals",
    "input",
    "locals",
    "open",
    "quit",
}


def fail(message, detail=None):
    print(json.dumps({"ok": False, "error": message, "detail": detail or ""}))
    sys.exit(1)


def validate_source(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        fail("生成代码存在语法错误", str(exc))

    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = []
            if isinstance(node, ast.Import):
                names = [item.name.split(".")[0] for item in node.names]
            else:
                names = [(node.module or "").split(".")[0]]
            blocked = [name for name in names if name in BLOCKED_IMPORTS]
            if blocked:
                fail("生成代码导入了沙盒禁用模块", ", ".join(blocked))

        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_CALLS:
                fail("生成代码调用了沙盒禁用函数", node.func.id)
            if isinstance(node.func, ast.Attribute) and node.func.attr in {"system", "popen", "remove", "unlink", "rmdir"}:
                fail("生成代码调用了沙盒禁用方法", node.func.attr)


def main():
    if len(sys.argv) != 5:
        fail("runner 参数错误")

    script_path = Path(sys.argv[1]).resolve()
    input_path = Path(sys.argv[2]).resolve()
    output_path = Path(sys.argv[3]).resolve()
    timeout_seconds = int(sys.argv[4])
    workdir = script_path.parent.resolve()

    if not script_path.is_file():
        fail("生成代码文件不存在")
    if not input_path.is_file():
        fail("源文件不存在")
    if workdir not in input_path.parents and input_path.parent != workdir:
        fail("源文件不在任务目录内")
    if output_path.parent.resolve() != workdir:
        fail("输出文件必须写入任务目录")

    source = script_path.read_text(encoding="utf-8")
    validate_source(source)

    def deny_network(*args, **kwargs):
        raise RuntimeError("沙盒禁止网络访问")

    socket.socket = deny_network

    def timeout_handler(signum, frame):
        raise TimeoutError("沙盒执行超时")

    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(timeout_seconds)

    globals_dict = {
        "__name__": "__main__",
        "INPUT_FILE": str(input_path),
        "OUTPUT_FILE": str(output_path),
    }

    try:
        exec(compile(source, str(script_path), "exec"), globals_dict)
    except Exception as exc:
        fail("生成代码执行失败", repr(exc))
    finally:
        if hasattr(signal, "alarm"):
            signal.alarm(0)

    if not output_path.exists():
        fail("生成代码未产出 output.xlsx")

    print(json.dumps({"ok": True, "output": str(output_path)}))


if __name__ == "__main__":
    main()
