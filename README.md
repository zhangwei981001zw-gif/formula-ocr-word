# 公式识别 → Word / MathType

一个纯前端、无需 API Key 的公式 OCR 网页：

- 截图后直接 `Ctrl+V` 粘贴
- 上传 / 拖拽公式图片
- 浏览器本地 OCR，图片不上传到识别服务器
- 输出并可编辑 LaTeX
- 浏览器原生 MathML 预览
- 一键复制到 Word / MathType，同时提供 LaTeX / MathML 备用复制

## 在线使用

GitHub Pages 地址：

`https://zhangwei981001zw-gif.github.io/formula-ocr-word/`

备用预览地址：

`https://raw.githack.com/zhangwei981001zw-gif/formula-ocr-word/main/index.html`

## 工作方式

公式识别使用 [Texo / FormulaNet](https://github.com/alephpi/Texo) 模型，通过 [Transformers.js](https://github.com/huggingface/transformers.js) 在浏览器中执行 ONNX 推理。首次使用需要下载模型文件（约 80 MB），之后通常会由浏览器缓存。

TeX → MathML 使用 [Temml](https://temml.org/)。

## 隐私

公式图片只在浏览器内进行预处理和推理，不发送到 Mathpix 或本项目自己的服务器。浏览器仍会从 CDN / Hugging Face 下载 JavaScript 库与开源模型文件。

## 许可与致谢

本项目使用的 FormulaNet / Texo 采用 GNU AGPL-3.0。为保持许可兼容，本项目源码同样按 **GNU AGPL-3.0-or-later** 提供。

- Texo / FormulaNet: Copyright © Sicheng Mao and contributors
- Transformers.js: Apache-2.0
- Temml: MIT

本项目按“现状”提供，不附带任何明示或暗示保证。
