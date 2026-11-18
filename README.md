# 砚藏联动

在安卓 TauriTavern 和砚藏之间导入、发送角色卡。扩展 0.2.8 适用于官方 TauriTavern 2.3.0，兼容砚藏 Android 0.8.5、0.8.6 和 0.9.8。

[下载砚藏](https://github.com/yanxu-orange/ST-Orange-Yancang/releases/latest)

## 安装与配对

1. 在 TauriTavern 打开「扩展 → 安装扩展」，粘贴以下链接并安装。已从此链接安装的用户可在扩展管理中检查更新。

   ```text
   https://github.com/yanxu-orange/ST-Orange-Yancang-TT-Bridge
   ```

2. 重载 TauriTavern，展开「砚藏联动」。如果联动已关闭，点「开启自动连接」。
3. 回到砚藏，在设置中打开「TauriTavern」开关，首次收到请求时点「允许连接」。以后两端开启时，已配对的设备可自动连接。

## 导入和发送

- 从 TauriTavern 导入：在砚藏打开「导入 → TauriTavern」，读取角色列表、勾选角色并点「导入所选」，在预览中确认入库。
- 发送到 TauriTavern：在砚藏角色卡详情打开「发送至酒馆 → TT」，确认后由 TauriTavern 自动接收为新角色。
- 读取和发送时请保持 TauriTavern 运行。连接中断时，重新打开两端并回到砚藏继续。如上次发送结果未确认，请先在 TauriTavern 核对角色是否已导入。

## 版本和反馈

仍使用连接码的砚藏旧版（例如 0.7.1）可继续用扩展 0.2.6.2。重新安装时，在 TT 的「分支或标签」栏填 `legacy-0.2.6.2`。也可以先更新砚藏，再升级扩展。

问题持续时，可在砚藏设置的 TauriTavern 一栏导出诊断。诊断不会自动上传。

作者：绫与小砚。仅供个人非商业使用，请勿二次分发或用于商业用途。请尊重角色卡及资源作者的权利。
