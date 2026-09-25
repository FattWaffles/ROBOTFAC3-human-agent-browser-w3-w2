// Copies exactly the files relay.py is allowed to serve into web-dist/, which Tauri embeds.
// tests/, relay.py, .git and everything else stay out of the app. Files that no longer exist in the
// source tree are removed from web-dist, so a renamed or deleted file never ships inside the bundle.
use std::{collections::HashSet, fs, path::{Path, PathBuf}};

const FILES: &[&str] = &["index.html", "styles.css"];
const DIRS: &[(&str, &[&str])] = &[("src", &["js", "txt"]), ("public", &["png", "svg", "ico"]), ("data", &["json"])];

// Only rewrites a file when its bytes changed, so builds don't churn.
fn sync(from: &Path, to: &Path, kept: &mut HashSet<PathBuf>) {
    let bytes = fs::read(from).expect("read web file");
    if fs::read(to).ok().as_deref() != Some(bytes.as_slice()) {
        fs::write(to, bytes).expect("write web file");
    }
    kept.insert(to.to_path_buf());
}

fn sync_dir(from: &Path, to: &Path, exts: &[&str], kept: &mut HashSet<PathBuf>) {
    fs::create_dir_all(to).expect("create web-dist dir");
    for entry in fs::read_dir(from).expect("read web dir") {
        let path = entry.expect("dir entry").path();
        let name = path.file_name().expect("file name");
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            sync_dir(&path, &to.join(name), exts, kept);
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.contains(&e)) {
            sync(&path, &to.join(name), kept);
        }
    }
}

// Removes everything under `dir` that this build did not write, then any directory left empty.
fn prune(dir: &Path, kept: &HashSet<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read web-dist dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            prune(&path, kept);
            if fs::read_dir(&path).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = fs::remove_dir(&path);
            }
        } else if !kept.contains(&path) {
            fs::remove_file(&path).expect("remove stale web file");
        }
    }
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest).join("..");
    let out = Path::new(&manifest).join("web-dist");
    fs::create_dir_all(&out).expect("create web-dist");
    let mut kept = HashSet::new();
    for f in FILES {
        sync(&root.join(f), &out.join(f), &mut kept);
        println!("cargo:rerun-if-changed=../{f}");
    }
    for (dir, exts) in DIRS {
        sync_dir(&root.join(dir), &out.join(dir), exts, &mut kept);
        println!("cargo:rerun-if-changed=../{dir}");
    }
    prune(&out, &kept);
    println!("cargo:rerun-if-changed=../chains.json");
    // Declaring the app's commands makes each one need an explicit permission in capabilities/.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["rpc", "evm_rpc", "rpc_info", "open_site"])),
    )
    .expect("tauri build step failed");
}
