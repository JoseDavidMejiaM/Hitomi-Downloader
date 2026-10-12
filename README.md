# Hitomi-Downloader

Descargador por lotes de galerias de [hitomi.la](https://hitomi.la) como archivos HTML autonomos, con lector integrado.
Es un script de Tampermonkey: se instala en el navegador y agrega un panel flotante a las paginas de hitomi.la.

Lo que lo diferencia de un descargador simple:

- **Examina listados completos** (artista, grupo, serie, personaje, tipo, tag, busqueda) con un solo clic.
- **Tabla persistente** con el estado de cada galeria (pendiente, descargando, OK, fallida). Sobrevive a recargas y reinicios del navegador.
- **Reintentos** de las galerias fallidas, una por una o todas juntas.
- **Historial en TXT**: al terminar el 100% sin fallos genera un TXT con los enlaces descargados. Si lo importas la proxima vez, esas galerias no se vuelven a bajar.

> Proyecto personal sin relacion con hitomi.la. Usalo bajo tu responsabilidad, respeta los terminos del sitio y las leyes de tu pais. El sitio contiene material para adultos.

---

## Capturas

| Panel minimizado (estado inicial) | Panel tras examinar un listado | Panel descargando |
|---|---|---|
| ![Panel minimizado](docs/panel-minimizado.png) | ![Panel examinar](docs/panel-examinar.png) | ![Panel descargando](docs/panel-descargando.png) |

![Tabla de descargas](docs/tabla.png)

---

## Requisitos

- Firefox, Chrome, Edge o Brave
- Extension Tampermonkey instalada y activa ([tampermonkey.net](https://www.tampermonkey.net/))
- Una pestana de `hitomi.la` abierta

---

## Instalacion

**Opcion A: un clic.** Con Tampermonkey instalado, abre el archivo en modo "raw" y confirma la instalacion:

```
https://raw.githubusercontent.com/JoseDavidMejiaM/Hitomi-Downloader/main/Hitomi-Downloader.user.js
```

**Opcion B: manual.**

1. Abre el Dashboard de Tampermonkey, ve a la pestana Scripts y pulsa el boton de nuevo script (icono +)
2. Borra el contenido de ejemplo y pega el contenido completo de `Hitomi-Downloader.user.js`
3. Guarda con Ctrl+S
4. Entra a cualquier pagina de hitomi.la. El panel aparece en la esquina inferior derecha, minimizado

El script solo se ejecuta en `https://hitomi.la/*` y solo se conecta a `hitomi.la`, `*.hitomi.la` y `*.gold-usergeneratedcontent.net` (declarado en `@connect`). No envia datos a ningun otro servidor.

---

## Por que HTML y no CBZ

Cada galeria se guarda como un unico archivo `.html` con las imagenes embebidas en Base64:

- Un solo archivo por galeria, que se abre en cualquier navegador sin instalar nada.
- Incluye un lector con barra lateral de miniaturas, modo scroll y modo paginado, y navegacion por teclado.
- Las imagenes se guardan tal como las sirve el sitio, sin recomprimir.

---

## Panel de control

El panel inicia **siempre minimizado**. Pulsa `+` en la barra de titulo (o haz doble clic sobre ella) para expandirlo. Se arrastra desde la barra de titulo y recuerda su posicion entre sesiones; si cambias de monitor o reduces la ventana, se reacomoda para que siempre quede visible.
<img width="356" height="471" alt="image" src="https://github.com/user-attachments/assets/1eab015e-fe4c-48c6-8657-023771c2a7ef" />

---

## Flujo de uso basico

### Primera vez

1. Ve a una pagina de artista, grupo, serie, tag o busqueda en hitomi.la
   Ejemplo: `https://hitomi.la/artist/nombre-all.html`
2. Expande el panel con el boton `+`
3. Pulsa **Examinar todo**. El panel indica cuantas galerias se encontraron y cuantas son nuevas
4. Pulsa **Iniciar descarga**
5. Cuando el 100% termina sin fallos, se descarga automaticamente un TXT con el historial

### La proxima vez que visites el mismo tag

1. Pulsa **Importar TXT** y elige el archivo generado antes (puedes elegir varios a la vez)
2. Ve al mismo listado en hitomi.la
3. Pulsa **Examinar todo**. Lo que ya esta en el TXT se omite; solo las nuevas entran a la cola
4. Pulsa **Iniciar descarga**

---

## Botones del panel

### Recolectar

| Boton | Descripcion |
|---|---|
| Examinar todo | Lee **el listado completo** de la pagina actual y agrega a la cola los IDs nuevos. No depende de la paginacion visible: usa los indices `.nozomi` del sitio, que contienen todas las galerias del artista o tag. Lo que ya esta en el historial se omite. |
| Manual | Abre un dialogo para escribir URLs, IDs numericos o terminos de busqueda directamente (ver "Entradas manuales"). |

**Examinar todo** funciona en: listados de artista, grupo, serie, personaje y tipo; tags (incluidos `female:` y `male:`); busquedas (`search.html?...`); indices por idioma y listados populares; y paginas de galeria o lector (en ese caso agrega esa galeria). Al terminar muestra cuantas galerias se **encontraron**, cuantas se agregaron, cuantas se omitieron por estar en el historial y cuantas ya estaban en la tabla.

Si un listado supera `MAX_IDS_PER_LISTING` (3000 por defecto), solo se agregan las mas recientes y el panel lo avisa con el total real encontrado.

### Control de descarga

| Boton | Descripcion |
|---|---|
| Iniciar descarga | **Solo inicia la descarga** de lo que ya esta en la cola. No examina nada. Si la cola esta vacia o solo hay fallidas, lo indica y no hace nada. |
| Pausar / Reanudar | Pausa al terminar la galeria en curso (no corta a la mitad). Mientras esta pausado el boton pasa a Reanudar. En reposo, Pausar no hace nada. |

Si recargas la pagina o navegas a otra pagina de hitomi.la durante una descarga, el script retoma la cola solo, devolviendo a pendiente la galeria que habia quedado a medias.

### Historial y tabla

| Boton | Descripcion |
|---|---|
| Ver tabla | Abre la tabla de descargas con resumen, filtros, paginacion y acciones por fila. |
| Importar TXT | Carga uno o varios TXT generados antes. Todo lo que figure queda en el historial y no se vuelve a descargar. Las filas pendientes que ya estaban en el TXT se quitan de la cola. |

### Mantenimiento

| Boton | Descripcion |
|---|---|
| Reintentar fallidas | Vuelve a poner en cola todas las filas fallidas y reanuda la descarga. |
| Limpiar tabla | Vacia la tabla (pide confirmacion). Las completadas pasan al historial; las pendientes y fallidas se pierden. El historial no se toca. |
| Limpiar historial | Borra solo el historial de galerias ya descargadas. La tabla no cambia. Util para volver a descargar todo desde cero. |
| Limpiar todo | Borra la tabla y el historial. |

---

## Entradas manuales

El boton **Manual** acepta una entrada por linea (o separadas por coma o punto y coma):

```
# URL de galeria directa
https://hitomi.la/doujinshi/titulo-123456.html

# ID numerico
789012

# Por artista
artist:nombre del artista

# Por tag con namespace
female:glasses

# Combinaciones
female:glasses language:english

# Con exclusiones (prefijo -)
series:nombre serie -female:ntr

# URL de listado completo
https://hitomi.la/artist/nombre-all.html
```

Los namespaces reconocidos son `artist`, `group`, `series`, `character`, `type`, `language` y los tags (`female:`, `male:` u otros). Los espacios pueden escribirse como espacios o como guion bajo. Lo que ya este en el historial se omite al agregar.

Hay dos botones: **Agregar a tabla** (solo encola) y **Agregar e iniciar** (encola y arranca la descarga).

---

## La tabla de descargas

Se abre con **Ver tabla** y se actualiza sola mientras descarga. Se muestra por encima del panel.

### Resumen superior

| Indicador | Significado |
|---|---|
| Encontrados | Total de galerias que encontro la ultima vez que usaste Examinar todo o Manual. Si hubo recorte por el limite, muestra tambien cuantas se tomaron. |
| En tabla | Filas que hay ahora en la tabla |
| Pend | Pendientes, esperando su turno |
| Desc | Descargando ahora mismo |
| OK | Completadas |
| Fail | Fallidas |
| Omitidas | Galerias descartadas por estar ya en el historial (acumulado entre examenes) |
| Historial | Enlaces registrados en el historial |

### Estados de cada fila

| Estado | Significado |
|---|---|
| Pendiente | En cola |
| Desc. X/Y | Descarga activa: imagen X de Y |
| OK | Todas las paginas descargadas |
| Fallida | Error o paginas faltantes; muestra el motivo y el numero de intento. Se puede reintentar |

### Filtros y columnas

Filtros: Todas, Pendientes, Descargando, Completadas, Fallidas. La tabla pagina de a 50 filas.
Columnas: numero, ID (enlace a la galeria), nombre, estado, paginas descargadas y acciones.

### Acciones por fila

- **R**: reintentar esa galeria (en una fila OK, la descarga de nuevo)
- **X**: quitar de la tabla (si estaba completada, pasa al historial antes de borrarse)

### Pie de la tabla

| Boton | Condicion |
|---|---|
| Reintentar fallidas | Activo solo si hay filas fallidas |
| Importar TXT | Siempre disponible |
| Exportar TXT | Disponible con el 100% completado, o con la tabla vacia si hay historial |
| Quitar completadas | Activo si hay filas OK; pasan al historial |
| Limpiar historial (N) | Activo si el historial tiene registros; no toca la tabla |

---

## El historial TXT

El TXT es el mecanismo central para no repetir descargas. Contiene una URL por linea, ordenadas por ID:

```
https://hitomi.la/doujinshi/titulo-111111.html
https://hitomi.la/manga/titulo-222222.html
https://hitomi.la/galleries/333333.html
```

- Se genera **automaticamente al completar el 100% de la cola sin ninguna fallida**. Si quedan fallidas, usa Reintentar fallidas hasta resolverlas y el TXT se genera al terminar esa vuelta.
- Tambien puedes exportarlo a mano desde el pie de la tabla (Exportar TXT) bajo las mismas condiciones.
- El archivo se llama `hitomi_descargados_AAAAMMDD_HHMM.txt`.
- Es **acumulativo**: incluye el historial importado mas lo descargado en la sesion. Conservando siempre el ultimo TXT tienes el registro completo.
- Al importar acepta URLs de galeria, IDs numericos sueltos y lineas de comentario que empiezan con `#`. Las lineas que no se reconocen se ignoran y se cuentan.

```
1ra vez   ->  examinar tag  ->  descargar todo  ->  TXT generado
                                                         |
Siguiente ->  importar TXT  ->  examinar mismo tag  ->  solo las nuevas
                                                         |
                             descargar nuevas  ->  TXT actualizado
```

---

## El archivo HTML descargado

Cada galeria se guarda con el nombre:

```
Titulo de la galeria [123456].html
```

Los caracteres no validos en nombres de archivo (`\ / : * ? " < > |`) se reemplazan por `_` y el titulo se recorta a 170 caracteres.

Una galeria solo se guarda si **todas** sus paginas se descargaron. Con `SAVE_INCOMPLETE` activado se guarda tambien con paginas faltantes, y esas paginas aparecen como "no se pudo descargar" dentro del lector.

El lector integrado incluye:

- Barra lateral de miniaturas con navegacion por clic
- Modo Scroll: desplazamiento vertical continuo (por defecto)
- Modo Paginado: una pagina a la vez, util en pantallas grandes
- Botones de primera, anterior, siguiente y ultima pagina
- Navegacion por teclado:

| Tecla | Accion |
|---|---|
| Flecha derecha o D | Pagina siguiente |
| Flecha izquierda o A | Pagina anterior |
| Espacio | Pagina siguiente |
| Home | Primera pagina |
| End | Ultima pagina |

---

## Como funciona por dentro

1. **Listados**: convierte la URL o el tag en el indice `.nozomi` correspondiente y lo decodifica (enteros de 4 bytes big-endian). Prueba varios hosts y recuerda el que funciona.
2. **Datos de cada galeria**: lee `galleries/<id>.js` para obtener titulo, numero de paginas y hashes.
3. **Direcciones de imagen**: lee `gg.js`, que cambia periodicamente, y con el hash de cada imagen arma la URL en `w1/w2.gold-usergeneratedcontent.net` (webp) y `a1` (avif cuando existe).
4. **Descarga**: 3 imagenes en paralelo con pausas cortas. Si faltan paginas, hace hasta 3 pasadas por galeria y entre pasadas vuelve a cargar `gg.js`.
5. **Control entre pestanas**: un candado evita que dos pestanas descarguen a la vez sobre la misma cola.

---

## Solucion de problemas

### Examinar todo no encuentra galerias
- Verifica que la pagina sea un listado valido (artista, tag, serie, busqueda) y no una pagina de sistema del sitio
- Prueba con el boton Manual escribiendo el tag directamente: `artist:nombre`
- Revisa el Log (boton en el pie del panel): muestra que indice se intento leer

### Galerias que siempre fallan
- Pueden ser galerias eliminadas o con acceso restringido (error 404 o 403)
- Los errores 400, 401, 403, 404 y 410 no se reintentan porque son permanentes
- Quitalas de la tabla con la **X** de su fila

### La descarga se detiene sola
- Puede que otra pestana tenga el control. Cierra las pestanas extra de hitomi.la y pulsa Iniciar descarga de nuevo
- Si una pestana se cerro de golpe, el candado se libera solo a los 2 minutos
- Al recargar la pagina, el script devuelve a pendiente las galerias interrumpidas y retoma la cola

### El navegador pide permiso para descargas multiples
Es normal: el script guarda varios archivos seguidos. Permitelo para `hitomi.la`.

### El TXT no se genera al terminar
- Debe haber 0 galerias fallidas y nada pendiente
- Si quedan fallidas, usa Reintentar fallidas y el TXT se genera al terminar esa vuelta
- Tambien puedes exportarlo desde el pie de la tabla cuando el estado sea 100% OK

### Paginas faltantes dentro de una galeria
- El script hace hasta 3 pasadas por galeria antes de marcarla como fallida
- Entre pasadas refresca el indice de URLs de imagen (`gg.js`)
- Si sigue fallando, reintentala mas tarde

---

## Limitaciones conocidas

- Todas las imagenes de una galeria se mantienen en memoria hasta guardarla. Las galerias muy largas pueden consumir bastante RAM.
- Cada listado esta limitado a `MAX_IDS_PER_LISTING` galerias (las mas recientes). Se puede subir en la configuracion.
- Se piden las imagenes en webp (y avif si existe). Para archivos que el sitio no ofrece en webp, solo se prueba una direccion antigua; esas galerias pueden quedar como fallidas.
- Depende de la estructura actual del sitio (`.nozomi`, `galleryinfo`, `gg.js`). Si el sitio cambia, hay que actualizar el script.
- Solo funciona en `hitomi.la`.

---

## Datos almacenados localmente

El script no envia ningun dato a servidores externos. Todo se guarda en el almacen local de Tampermonkey:

| Clave | Contenido |
|---|---|
| `hdl_v5_items` | Cola de descargas (filas con estado) |
| `hdl_v5_history` | Historial de galerias descargadas `{id: url}` |
| `hdl_v5_progress` | Progreso de la galeria en curso |
| `hdl_v5_meta` | Metadatos internos (omitidas, ultimo examen, ultimo TXT) |
| `hdl_v5_running` | Estado del bucle (activo o detenido) |
| `hdl_v5_lock` | Candado para evitar descargas simultaneas entre pestanas |
| `hdl_v5_log` | Ultimas 100 lineas del log interno |
| `hdl_v5_ui_pos` | Posicion del panel en pantalla |
| `hdl_v5_nozomi_base_idx` | Host preferido para los indices |

Para borrar todo usa el boton **Limpiar todo** del panel. Tambien puedes borrar claves sueltas desde el Dashboard de Tampermonkey, en la pestana de almacenamiento del script (visible en el modo de configuracion avanzado).

---

## Configuracion avanzada

Edita el bloque `CFG` al inicio del script:

| Parametro | Valor por defecto | Descripcion |
|---|---|---|
| `DELAY_BETWEEN_GALLERIES` | 4000 ms | Pausa entre galerias |
| `DELAY_BETWEEN_IMAGES` | 150 ms | Pausa entre imagenes por cada trabajador |
| `IMAGE_CONCURRENCY` | 3 | Imagenes descargadas en paralelo |
| `MAX_RETRIES` | 2 | Reintentos por peticion fallida |
| `TIMEOUT_FETCH` | 45000 ms | Tiempo maximo por peticion |
| `BACKOFF_BASE` | 1500 ms | Espera base entre reintentos (se duplica en cada intento) |
| `MAX_IDS_PER_LISTING` | 3000 | Limite de galerias por listado |
| `GG_TTL` | 300000 ms | Tiempo que se reutiliza `gg.js` antes de volver a pedirlo |
| `LOCK_STALE_MS` | 120000 ms | Tiempo tras el cual se considera caido el candado de otra pestana |
| `IMAGE_PASSES` | 3 | Pasadas por galeria antes de marcarla fallida |
| `PASS_PAUSE` | 4000 ms | Pausa entre pasadas |
| `SAVE_INCOMPLETE` | false | Guardar el HTML aunque falten paginas (la fila igual queda como fallida) |
| `TXT_INCLUDE_HISTORY` | true | El TXT acumula el historial importado |
| `TABLE_PAGE_SIZE` | 50 | Filas por pagina en la tabla |

Si el sitio responde con errores por demasiadas peticiones, reduce `IMAGE_CONCURRENCY` o aumenta los retardos.

---

## Apoyo al proyecto

Si el script te fue util puedes apoyar con una donacion:

- [Ko-fi](https://ko-fi.com/josemejiam)
- [PayPal](https://paypal.me/JoseDMejiaM)

Tambien puedes reportar errores o proponer mejoras en [Issues](https://github.com/JoseDavidMejiaM/Hitomi-Downloader/issues).
