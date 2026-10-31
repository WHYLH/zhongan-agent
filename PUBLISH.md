# 发布到 GitHub（一次性操作）

本目录 `tmp/github-ready/zhongan-agent` 是一个干净的项目仓库内容
（不含密钥、模型权重、EXE/APK 构建产物、服务器 IP 与内部过程文档）。

## 步骤

1. 在 GitHub 网页上创建一个**空仓库**，名称建议 `zhongan-agent`，不要勾选 README/.gitignore/License。

2. 在本目录初始化并推送（把 `<GITHUB用户名>` 换成你的用户名）：

```powershell
cd "tmp\github-ready\zhongan-agent"
git init -b main
git add -A
git commit -m "众安 Agent：源代码、部署材料与测试用例（初始提交）"
git remote add origin https://github.com/<GITHUB用户名>/zhongan-agent.git
git push -u origin main
```

推送时如果弹出 Git Credential Manager 登录窗口，用浏览器授权一次即可。

3. 推送完成后，把仓库地址填入两处：
   - `参赛材料/03-源代码与部署材料/README.md` 第 8 节的 `<GITHUB用户名>`；
   - 重新执行 `node scripts/package-submission.mjs` 生成最终提交包。

## 或者用 GitHub CLI（如果已安装 gh）

```powershell
cd "tmp\github-ready\zhongan-agent"
gh repo create zhongan-agent --public --source . --push
```

## 更新仓库

项目根目录内容变化后：

```powershell
node scripts/package-submission.mjs   # 重新生成提交包与 staging 目录
# 把 submission-output/zhongan-bank-agent 的内容覆盖到本目录（保留 .git 与 .gitignore）
# 然后正常 git add/commit/push
```
