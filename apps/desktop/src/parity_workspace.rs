//! 带 IO 的对拍用例共用的临时 workspace，以及初始文件树的铺设与读回。
//!
//! fixture 只描述「初始文件树 + 操作 + 期望结果」，临时目录本身不进 fixture。TS 侧有一份同语义的
//! 实现（`packages/host-node/src/parity/workspaceTree.testHarness.ts`）。
//!
//! 形状是 `<base>/workspace` + `<base>/journal`：日志目录是 workspace 的**兄弟**而不是它下面的
//! 隐藏目录，否则日志文件会混进「跑完之后 workspace 里有哪些文件」的穷举比对里。
//!
//! **读回来的是穷举**：多一个文件或少一个文件都要能看出来，所以递归枚举全部普通文件而不是按
//! fixture 里列的键去逐个查。按键去查的话，「本该被删掉的文件其实还在」这种分岔会静默通过。
//! 目录本身不进结果——两个宿主对「删完文件后空目录留不留」没有共同承诺。

use serde_json::{Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct ParityWorkspace {
    /// workspace 与 journal 的公共父目录，清理时整棵删掉。
    base: PathBuf,
    /// workspace root，已 canonicalize（`resolve_workspace_path` 的 `starts_with(root)` 要求它是）。
    pub(crate) root: PathBuf,
    /// 变更日志目录，**尚不存在**——登记要能自己把它建出来。
    pub(crate) journal: PathBuf,
}

impl ParityWorkspace {
    /// 每次调用一个独立目录（Rust 测试在进程内并发跑，用 pid + 计数器避免撞名）。
    pub(crate) fn create() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "web_agent_parity_{}_{}",
            std::process::id(),
            sequence
        ));
        let workspace = base.join("workspace");
        fs::create_dir_all(&workspace).expect("建临时 workspace");
        Self {
            root: fs::canonicalize(&workspace).expect("canonicalize 临时 workspace"),
            journal: base.join("journal"),
            base,
        }
    }

    pub(crate) fn cleanup(&self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

/// 按 fixture 的 `initialFiles` 铺好初始树。父目录按需创建。
pub(crate) fn seed_tree(root: &Path, tree: &Value) -> Result<(), String> {
    let entries = tree
        .as_object()
        .ok_or_else(|| "    initialFiles 必须是对象".to_string())?;
    for (relative_path, content) in entries {
        let absolute = root.join(relative_path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("    建初始目录失败: {err}"))?;
        }
        let text = content
            .as_str()
            .ok_or_else(|| format!("    initialFiles[{relative_path}] 必须是字符串"))?;
        fs::write(&absolute, text).map_err(|err| format!("    写初始文件失败: {err}"))?;
    }
    Ok(())
}

/// 递归读回 workspace 里的**全部**普通文件，键是根相对的正斜杠路径。
pub(crate) fn read_tree(root: &Path) -> Result<Value, String> {
    let mut tree = Map::new();
    collect(root, root, &mut tree)?;
    Ok(Value::Object(tree))
}

fn collect(root: &Path, directory: &Path, tree: &mut Map<String, Value>) -> Result<(), String> {
    let entries =
        fs::read_dir(directory).map_err(|err| format!("    读目录 {directory:?} 失败: {err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("    读目录项失败: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("    读 {path:?} 的类型失败: {err}"))?;
        if file_type.is_dir() {
            collect(root, &path, tree)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|err| format!("    {path:?} 不在根下: {err}"))?
                .to_string_lossy()
                .replace('\\', "/");
            let content =
                fs::read_to_string(&path).map_err(|err| format!("    读 {path:?} 失败: {err}"))?;
            tree.insert(relative, Value::String(content));
        }
    }
    Ok(())
}

/// 直接读磁盘上那份变更日志条目的 `status`；条目不存在（或读不动）时给 `null`。
///
/// **刻意不走 `read_entry`**：对拍要比的是两个宿主**落下来的产物**，借一侧的读取函数去解释它，
/// 等于让被测代码给自己判卷——条目里少写了一个键，收窄那一层可能补个默认值，分岔就被抹平了。
pub(crate) fn read_entry_status(journal: &Path, change_id: &str) -> Value {
    let path = journal.join(format!("{change_id}.json"));
    let Ok(raw) = fs::read_to_string(path) else {
        return Value::Null;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Value::Null;
    };
    parsed.get("status").cloned().unwrap_or(Value::Null)
}
