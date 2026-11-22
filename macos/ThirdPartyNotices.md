# LineEcho 第三方组件

- **Kokoro-82M** · [hexgrad 原始模型](https://huggingface.co/hexgrad/Kokoro-82M)和 [MLX Community BF16 转换版](https://huggingface.co/mlx-community/Kokoro-82M-bf16/tree/a71e4d38b236d968966a2002c4c895dbd12b1c3c)采用 [Apache License 2.0](licenses/Apache-2.0.txt)。
- **英译简中模型** · Mozilla Firefox Translations 的英语到简体中文 v3.0 语言包采用 [Mozilla Public License 2.0](licenses/MPL-2.0.txt)。安装包内的 `models/MTranServer/models/en_zh-Hans/` 保留了原始 Mozilla 模型和词表。`manifest.json` 包含上游下载链接及校验和。`model.onnx` 由 [MTranServer](https://github.com/xxnuo/MTranServer) 5.1.1 转换生成。模型项目的 [Mozilla 源码](https://github.com/mozilla/translations)及 MTranServer 源码可从上游获得。MTranServer 采用 [Apache License 2.0](licenses/Apache-2.0.txt)。
- **eSpeak NG** · 由 `espeakng-loader` 0.2.4 提供给 Misaki 英文音素处理。随附的 eSpeak NG 库及语言数据使用 [GNU GPL 3.0 或更新版本](licenses/GPL-3.0.txt)。参见 [eSpeak NG 1.52.0 源码](https://github.com/espeak-ng/espeak-ng/tree/1.52.0)和 [espeakng-loader 源码与构建步骤](https://github.com/thewh1teagle/espeakng-loader)。Python 加载器采用 [MIT License](licenses/espeakng-loader-MIT.txt)。
- **其他依赖** · Python、Node.js 及随包分发的 Python 和 Node.js 依赖保留各自的许可证。Inter 和 Newsreader 的 SIL Open Font License 文本位于 `frontend/fonts/`。
