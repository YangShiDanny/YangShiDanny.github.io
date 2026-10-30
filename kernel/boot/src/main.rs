//! 引导包装：`cargo run -p lumeos-boot --release`
//!
//! 负责三件事，顺序不能反：
//!   1. 编内核（nightly + build-std，target x86_64-unknown-none）
//!   2. 把内核 ELF 套上 bootloader 的 BIOS 引导代码，写出可引导 .img
//!   3. 有 grub-mkrescue 就顺手打一个 .iso

use std::path::{Path, PathBuf};
use std::process::Command;

fn sh(cmd: &str, args: &[&str], cwd: &Path) -> bool {
    println!("  $ {} {}", cmd, args.join(" "));
    match Command::new(cmd).args(args).current_dir(cwd).status() {
        Ok(s) => s.success(),
        Err(e) => {
            println!("    ! {cmd} 起不来: {e}");
            false
        }
    }
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("boot crate 应该在 kernel/ 下")
        .to_path_buf();
    let images = root.join("target/images");
    std::fs::create_dir_all(&images).expect("建不出 target/images");

    println!("[1/3] 编译内核");
    // 必须显式带 --target：从仓库根跑 cargo 不会读 kernel/.cargo/config.toml，
    // 不带就编给宿主机，链接时报一堆 "can't find crate for `std`" 的反向错误。
    if !sh(
        "cargo",
        &[
            "build",
            "-p",
            "lumeos-kernel",
            "--release",
            "--target",
            "x86_64-unknown-none",
        ],
        &root,
    ) {
        eprintln!("内核没编过，先修编译错误");
        std::process::exit(1);
    }

    let kernel_bin = root.join("target/x86_64-unknown-none/release/lumeos-kernel");
    if !kernel_bin.exists() {
        eprintln!("找不到内核产物: {}", kernel_bin.display());
        std::process::exit(1);
    }
    println!(
        "      内核 {} KB",
        std::fs::metadata(&kernel_bin).map(|m| m.len()).unwrap_or(0) / 1024
    );

    println!("[2/3] 生成可引导磁盘映像");
    let img = images.join("lumeos.img");
    // bootloader 0.11 的 BIOS 路线：create_bios_image 直接写 MBR + FAT 分区 + 内核
    // （0.11 没有 create_disk_image 这个名字，那是 0.9 的老 API）
    //
    // 顺带把 stage-4 的日志打到**串口**而不是屏幕：它默认会往 framebuffer 上
    // 打几十行 INFO，把内核醒来后要用的画面全盖住。内核自己不再用 framebuffer，
    // 而是走 VGA 文字模式（0xB8000），所以屏幕上那一层得先空出来。
    let mut boot_cfg = bootloader::BootConfig::default();
    boot_cfg.frame_buffer_logging = false;
    boot_cfg.serial_logging = true;

    let mut builder = bootloader::DiskImageBuilder::new(kernel_bin.clone());
    builder.set_boot_config(&boot_cfg);
    builder.create_bios_image(&img).expect("create_bios_image 失败");
    println!(
        "      {} ({} KB)",
        img.display(),
        std::fs::metadata(&img).map(|m| m.len()).unwrap_or(0) / 1024
    );

    println!("[3/3] 打 ISO（没有 grub-mkrescue 就跳过）");
    let iso_root = images.join("iso");
    let _ = std::fs::remove_dir_all(&iso_root);
    std::fs::create_dir_all(iso_root.join("boot/grub")).ok();
    if std::fs::copy(&kernel_bin, iso_root.join("boot/lumeos-kernel")).is_ok() {
        std::fs::write(
            iso_root.join("boot/grub/grub.cfg"),
            "set timeout=0\nset default=0\n\
             menuentry \"LumeOS\" {\n\tmultiboot2 /boot/lumeos-kernel\n\tboot\n}\n",
        )
        .ok();
        let iso = images.join("lumeos.iso");
        if !sh(
            "grub-mkrescue",
            &["-o", iso.to_str().unwrap(), iso_root.to_str().unwrap()],
            &root,
        ) {
            println!("      grub-mkrescue 失败，跳过 ISO（.img 照样能引导）");
        }
    }

    println!("\n跑起来看看：");
    println!(
        "  qemu-system-x86_64 -drive format=raw,file={} -serial stdio",
        img.display()
    );
}
