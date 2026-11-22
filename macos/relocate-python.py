"""Stage the runtime of a python.org Python 3.13 installation for the local app."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

source = Path(sys.base_prefix).resolve()
output = Path(sys.argv[1]).resolve()
if sys.version_info[:2] != (3, 13) or not (source / "Python").is_file():
    raise SystemExit("需要 python.org 安装的 ARM64 Python 3.13，或提供经校验的独立 Python 安装包。")

(output / "bin").mkdir(parents=True)
shutil.copy2(source / "Python", output)
# The framework's bin/python3.13 is a launcher for this embedded interpreter.
shutil.copy2(source / "Resources/Python.app/Contents/MacOS/Python", output / "bin/python3.13")
(output / "bin/python3").symlink_to("python3.13")
shutil.copytree(
    source / "lib", output / "lib", symlinks=True,
    ignore=shutil.ignore_patterns("site-packages", "__pycache__", "*.pyc", "test", "tests",
                                  "pkgconfig", "config-*", "*.a", "_tkinter*.so"),
)

for binary in [output / "Python", output / "bin/python3.13", *output.glob("lib/*.dylib"),
               *output.glob("lib/python3.13/lib-dynload/*.so")]:
    if binary.is_symlink():
        continue
    archs = subprocess.check_output(["lipo", "-archs", binary], text=True).split()
    if "arm64" not in archs:
        raise ValueError(f"运行时架构不匹配: {binary.name}")
    if len(archs) > 1:
        thin = binary.with_name(binary.name + ".arm64")
        subprocess.run(["lipo", binary, "-thin", "arm64", "-output", thin], check=True)
        thin.replace(binary)
    dependencies = subprocess.check_output(["otool", "-L", binary], text=True).splitlines()[1:]
    changes = []
    for line in dependencies:
        dependency = line.strip().split(" (compatibility version", 1)[0]
        if not dependency.startswith(str(source) + "/"):
            continue
        relative = Path(dependency).relative_to(source)
        target = output / relative
        if not target.exists():
            raise ValueError(f"运行时缺少依赖: {relative}")
        if target.resolve() == binary.resolve():
            changes.extend(["-id", f"@rpath/{relative}"])
        else:
            changes.extend(["-change", dependency, "@loader_path/" + os.path.relpath(target, binary.parent)])
    if changes:
        subprocess.run(["install_name_tool", *changes, binary], check=True, capture_output=True)
    subprocess.run(["codesign", "--force", "--sign", "-", binary], check=True, capture_output=True)

subprocess.run([output / "bin/python3", "-I", "-B", "-c",
                "import ssl, sqlite3, lzma, ctypes, pathlib, sys; assert pathlib.Path(sys.prefix).resolve() == pathlib.Path(sys.argv[1])",
                output], check=True)
