import os
import base64
import shutil
import zipfile
import webbrowser
from pathlib import Path
import threading
import tkinter as tk
from tkinter import ttk, filedialog, scrolledtext, messagebox

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

# ─── AppUserModelID: necesario para que Windows asocie el ícono en la barra de tareas ───
try:
    import ctypes
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
        "com.ingenieromultimedia.htmlcomicconverter"
    )
except Exception:
    pass

# ─── Extensiones de imagen válidas ───
VALID_IMAGE_EXTS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"})

# ─── URLs de donación ───
KOFI_URL   = "http://ko-fi.com/josemejiam"
PAYPAL_URL = "https://paypal.me/JoseDMejiaM"


def _set_icon(window: tk.Wm, ico_path: str = "icono.ico") -> None:
    """Aplica el ícono .ico a una ventana tkinter de forma segura."""
    if os.path.exists(ico_path):
        try:
            window.iconbitmap(default=ico_path)  # 'default' propaga a ventanas hijas
        except Exception:
            pass


class ComicConverterApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Conversor HTML")
        self.geometry("760x620")
        self.minsize(640, 520)

        # Ícono: 'default=' hace que todas las Toplevel hereden el mismo ícono
        _set_icon(self)

        ttk.Style().theme_use("clam")
        self._build_widgets()
        self.after(500, self._check_first_run)

    # ── UI ──────────────────────────────────────────────────────────────────

    def _build_widgets(self) -> None:
        main = ttk.Frame(self, padding="15")
        main.pack(fill=tk.BOTH, expand=True)

        # Directorio de entrada
        folder_frame = ttk.LabelFrame(main, text="Directorio con Archivos HTML", padding="10")
        folder_frame.pack(fill=tk.X, pady=(0, 10))

        self.path_var = tk.StringVar()
        ttk.Entry(folder_frame, textvariable=self.path_var, font=("Arial", 10)).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 8)
        )
        ttk.Button(folder_frame, text="Examinar...", command=self._browse_folder).pack(side=tk.RIGHT)

        # Opciones de salida
        opts = ttk.LabelFrame(main, text="Formatos de Salida a Generar", padding="10")
        opts.pack(fill=tk.X, pady=(0, 10))

        self.var_carpeta = tk.BooleanVar(value=False)
        self.var_cbz     = tk.BooleanVar(value=False)
        self.var_cbr     = tk.BooleanVar(value=False)

        ttk.Checkbutton(opts, text="Crear carpeta separada con imágenes ordenadas",
                        variable=self.var_carpeta).pack(anchor=tk.W, pady=3)
        ttk.Checkbutton(opts, text="Crear archivo .CBZ (Formato estándar ZIP para lectores)",
                        variable=self.var_cbz).pack(anchor=tk.W, pady=3)
        ttk.Checkbutton(opts, text="Crear archivo .CBR (Contenedor compatible con lectores)",
                        variable=self.var_cbr).pack(anchor=tk.W, pady=3)

        # Botón principal
        self.btn_start = ttk.Button(main, text="Iniciar Conversión Masiva",
                                    command=self._start_conversion)
        self.btn_start.pack(fill=tk.X, pady=(0, 10), ipady=6)

        # Log en vivo
        log_frame = ttk.LabelFrame(main, text="Progreso y Registro en Tiempo Real", padding="10")
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.log_area = scrolledtext.ScrolledText(
            log_frame, wrap=tk.WORD, height=10, font=("Consolas", 9), state=tk.DISABLED
        )
        self.log_area.pack(fill=tk.BOTH, expand=True)

        # Pie de página
        footer = ttk.Frame(main)
        footer.pack(fill=tk.X, pady=(8, 0))

        ttk.Label(footer, text="Conversor masivo de HTML a cómic de código abierto",
                  font=("Arial", 8), foreground="gray").pack(side=tk.LEFT)

        donate = ttk.Frame(footer)
        donate.pack(side=tk.RIGHT)

        tk.Button(donate, text="☕ Ko-fi", bg="#ff5e5b", fg="white",
                  font=("Arial", 8, "bold"), relief=tk.FLAT, padx=6, pady=2,
                  cursor="hand2", command=lambda: webbrowser.open(KOFI_URL)
                  ).pack(side=tk.RIGHT, padx=(4, 0))
        tk.Button(donate, text="🅿️ PayPal", bg="#0070ba", fg="white",
                  font=("Arial", 8, "bold"), relief=tk.FLAT, padx=6, pady=2,
                  cursor="hand2", command=lambda: webbrowser.open(PAYPAL_URL)
                  ).pack(side=tk.RIGHT)

    # ── Primer inicio ────────────────────────────────────────────────────────

    def _check_first_run(self) -> None:
        flag = Path("config_iniciado.flag")
        if flag.exists():
            return

        win = tk.Toplevel(self)
        win.title("¡Gracias por descargar!")
        win.geometry("440x330")
        win.resizable(False, False)
        win.grab_set()
        _set_icon(win)

        # Centrar la ventana
        win.update_idletasks()
        x = (win.winfo_screenwidth()  - 440) // 2
        y = (win.winfo_screenheight() - 330) // 2
        win.geometry(f"440x330+{x}+{y}")

        box = ttk.Frame(win, padding="20")
        box.pack(fill=tk.BOTH, expand=True)

        ttk.Label(box, text="Bienvenido", font=("Arial", 11, "bold")).pack(pady=(5, 10))
        ttk.Label(
            box,
            text=(
                "Muchas gracias por descargar esta herramienta.\n\n"
                "Este software es totalmente gratuito y de código abierto.\n"
                "Si te ahorra tiempo convirtiendo tus archivos y te resulta útil, "
                "por favor considera apoyar el desarrollo continuo con una pequeña donación."
            ),
            justify=tk.CENTER, wraplength=390, font=("Arial", 9)
        ).pack(pady=5)

        btns = ttk.Frame(box)
        btns.pack(pady=12)
        tk.Button(btns, text="☕ Invítame un café (Ko-fi)", bg="#ff5e5b", fg="white",
                  font=("Arial", 9, "bold"), relief=tk.FLAT, padx=8, pady=5,
                  cursor="hand2", command=lambda: webbrowser.open(KOFI_URL)
                  ).pack(side=tk.LEFT, padx=5)
        tk.Button(btns, text="🅿️ Donar (PayPal)", bg="#0070ba", fg="white",
                  font=("Arial", 9, "bold"), relief=tk.FLAT, padx=8, pady=5,
                  cursor="hand2", command=lambda: webbrowser.open(PAYPAL_URL)
                  ).pack(side=tk.LEFT, padx=5)

        def _close() -> None:
            try:
                flag.touch()
            except OSError:
                pass
            win.destroy()

        win.protocol("WM_DELETE_WINDOW", _close)
        ttk.Button(box, text="Continuar a la aplicación",
                   command=_close).pack(pady=(10, 0), ipadx=10, ipady=3)

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _browse_folder(self) -> None:
        path = filedialog.askdirectory()
        if path:
            self.path_var.set(path)

    def _log(self, message: str) -> None:
        """Escribe en el área de log de forma thread-safe."""
        def _write():
            self.log_area.config(state=tk.NORMAL)
            self.log_area.insert(tk.END, message + "\n")
            self.log_area.see(tk.END)
            self.log_area.config(state=tk.DISABLED)
        self.after(0, _write)

    def _set_btn(self, state: str) -> None:
        """Cambia el estado del botón de forma thread-safe."""
        self.after(0, lambda: self.btn_start.config(state=state))

    # ── Conversión ───────────────────────────────────────────────────────────

    def _start_conversion(self) -> None:
        if BeautifulSoup is None:
            messagebox.showerror("Dependencia faltante",
                                 "Instala BeautifulSoup4:\n  pip install beautifulsoup4")
            return

        ruta = self.path_var.get().strip()
        if not ruta or not os.path.isdir(ruta):
            messagebox.showerror("Error", "Por favor, selecciona una ruta de carpeta válida.")
            return

        if not (self.var_carpeta.get() or self.var_cbz.get() or self.var_cbr.get()):
            messagebox.showwarning("Atención", "Debes seleccionar al menos un formato de salida.")
            return

        self.btn_start.config(state=tk.DISABLED)
        self._log("=== INICIANDO PROCESO DE CONVERSIÓN MASIVA ===")
        threading.Thread(target=self._run_conversion, args=(ruta,), daemon=True).start()

    def _run_conversion(self, directorio: str) -> None:
        try:
            entrada = Path(directorio)
            html_files = sorted(
                list(entrada.glob("*.html")) + list(entrada.glob("*.htm"))
            )

            if not html_files:
                self._log("❌ No se encontraron archivos HTML o HTM en el directorio especificado.")
                return

            self._log(f"📁 Se encontraron {len(html_files)} archivos HTML para procesar.\n")

            for html_path in html_files:
                self._log(f"⚙️  Procesando: {html_path.name}...")
                nombre_base   = html_path.stem
                temp_dir      = entrada / f"_temp_{nombre_base}"
                temp_dir.mkdir(exist_ok=True)

                try:
                    guardadas = self._extract_images(html_path, temp_dir)
                except Exception as exc:
                    self._log(f"  ❌ Error procesando {html_path.name}: {exc}")
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    continue

                if guardadas:
                    self._log(f"  ✅ {guardadas} imágenes extraídas y ordenadas.")
                    self._emit_outputs(entrada, nombre_base, temp_dir)
                else:
                    self._log(f"  ⚠️  No se encontraron imágenes válidas en {html_path.name}")

                shutil.rmtree(temp_dir, ignore_errors=True)
                self._log("-" * 40)

            self._log("\n✅ Proceso por lotes finalizado con éxito es hora de la paja barbara XD.")
            self.after(0, lambda: messagebox.showinfo(
                "Proceso Finalizado", "La conversión masiva ha terminado correctamente."
            ))

        except Exception as exc:
            self._log(f"❌ Error inesperado: {exc}")
            self.after(0, lambda: messagebox.showerror("Error", f"Ocurrió un error: {exc}"))
        finally:
            self._set_btn(tk.NORMAL)

    def _extract_images(self, html_path: Path, dest_dir: Path) -> int:
        """Extrae imágenes de un HTML a dest_dir. Devuelve la cantidad guardada."""
        with open(html_path, "r", encoding="utf-8", errors="ignore") as fh:
            soup = BeautifulSoup(fh, "html.parser")

        contador = 1
        guardadas = 0

        for img in soup.find_all("img"):
            src = img.get("src") or img.get("data-src") or img.get("data-original")
            if not src:
                continue

            if src.startswith("data:image/"):
                saved = self._save_base64_image(src, dest_dir, contador)
            elif not src.startswith(("http://", "https://")):
                saved = self._save_local_image(src, html_path.parent, dest_dir, contador)
            else:
                continue

            if saved:
                guardadas += 1
                contador  += 1

        return guardadas

    @staticmethod
    def _save_base64_image(src: str, dest_dir: Path, index: int) -> bool:
        """Decodifica y guarda una imagen en Base64. Retorna True si tuvo éxito."""
        try:
            header, encoded = src.split(",", 1)
            ext = ".jpg"
            for fmt in ("png", "webp", "gif", "avif"):
                if fmt in header:
                    ext = f".{fmt}"
                    break
            data = base64.b64decode(encoded)
            (dest_dir / f"{index:03d}{ext}").write_bytes(data)
            return True
        except Exception:
            return False

    @staticmethod
    def _save_local_image(src: str, base_dir: Path, dest_dir: Path, index: int) -> bool:
        """Copia una imagen local al directorio temporal. Retorna True si tuvo éxito."""
        candidates = [base_dir / src, base_dir / Path(src).name]
        for cand in candidates:
            if cand.is_file():
                ext = cand.suffix.lower()
                if ext not in VALID_IMAGE_EXTS:
                    ext = ".jpg"
                dest = dest_dir / f"{index:03d}{ext}"
                shutil.copy2(cand, dest)   # copy2 preserva metadatos
                return True
        return False

    def _emit_outputs(self, base_dir: Path, name: str, temp_dir: Path) -> None:
        """Genera los formatos de salida seleccionados."""
        sorted_imgs = sorted(temp_dir.glob("*.*"))

        if self.var_carpeta.get():
            out_folder = base_dir / name
            if out_folder.exists():
                shutil.rmtree(out_folder)
            shutil.copytree(temp_dir, out_folder)
            self._log(f"  📂 Carpeta generada: {out_folder.name}")

        for ext, flag in ((".cbz", self.var_cbz), (".cbr", self.var_cbr)):
            if not flag.get():
                continue
            out_path = base_dir / f"{name}{ext}"
            with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                for img in sorted_imgs:
                    zf.write(img, img.name)
            self._log(f"  📦 Archivo {ext.upper()[1:]} creado: {out_path.name}")


if __name__ == "__main__":
    app = ComicConverterApp()
    app.mainloop()