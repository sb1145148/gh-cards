# 第三方素材

本仓库代码采用 [MIT](LICENSE)。下面是内嵌/引用的第三方素材，各自授权不同。

## Caveat 字体

| 项 | 内容 |
| --- | --- |
| 文件 | `src/font.js`（woff2 + ttf，base64 内嵌） |
| 来源 | https://github.com/googlefonts/caveat |
| 版权 | Copyright 2014 The Caveat Project Authors |
| 授权 | **SIL Open Font License 1.1** |
| 全文 | [`third-party/Caveat-OFL-1.1.txt`](third-party/Caveat-OFL-1.1.txt) |

### 做了什么改动

- **只做了子集化**：保留卡片渲染用到的字符，减小体积
- **未修改字形**
- **未单独出售字体**

符合 OFL 对「保留字体名 + 不单独售卖」的要求。完整条款见上面的授权全文。

## 其它

- `@deepseek-ai` 相关依赖：MIT（在 `package.json` 依赖里）
- Cloudflare Worker 运行时不打包任何第三方代码

---

如果你的使用场景涉及再分发，请同时遵守 MIT（代码）和 OFL 1.1（字体）两份条款。
