# Claudeway — opencode-claudeway

Plugin no oficial y propio para utilizar credenciales existentes de Claude Code
en OpenCode V2. Basado en una migración selectiva de
[opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth), no en
una modificación de ese repositorio.

**Estado: JavaScript único, con renovación OAuth automática bajo demanda; experimental.**
La versión anterior validó una generación real: **HTTP 200 y `OK`** con
`claude-haiku-4-5`, Bearer OAuth y sin API key, después de corregir el `400 extra-usage`.
La migración JS y la renovación se han validado solo con fixtures: **no se han
renovado ni escrito credenciales reales en esta etapa**.
No está listo para distribución: sigue existiendo una limitación de
redirecciones del host que no permite garantizar su bloqueo en producción; consulta
[`docs/compatibility.md`](docs/compatibility.md).

## Instalación desde GitHub

Requiere OpenCode **V2** (verificado con `2.0.29`), una sesión existente en Claude
Code y acceso al repositorio por SSH. No necesitas publicar ni instalar nada desde
npm; `private: true` solo evita su publicación accidental.

```sh
opencode plugin add 'git+ssh://git@github.com/tamecl/opencode-claudeway.git#main'
opencode plugin list
```

El primer comando instala el paquete y lo añade a la configuración **global** de
OpenCode. La instalación de dependencias la gestiona OpenCode; no necesitas
clonar el repositorio, instalar pnpm ni compilar para este método.

Después, dentro de OpenCode:

1. Ejecuta `/connect` y selecciona **Anthropic**.
2. Elige **Claude Code credentials (Claudeway)** y deja activa esa cuenta.
3. Ejecuta `/models` y selecciona el modelo Claude que quieras utilizar.

Si el plugin no aparece activo tras instalarlo, reinicia el servicio:

```sh
opencode service restart
```

No copies tokens ni elijas el método API key. Conectar Claudeway puede renovar y
actualizar la fuente de Claude Code si está próxima a caducar. Para fijar una
revisión, sustituye `#main` por el hash completo del commit deseado. Para actualizar
solo esta instalación:

```sh
opencode plugin update 'git+ssh://git@github.com/tamecl/opencode-claudeway.git#main'
```

Usa este método **o** el directorio local descrito más abajo, no ambos. Instalar
desde Git no cambia el carácter experimental ni las limitaciones de seguridad.

## Desarrollo local

OpenCode objetivo: `2.0.29`. Node para desarrollo: `24.12+`. pnpm: `10.32.1`.
Todo el código y las pruebas usan JavaScript ESM; no se requiere Python,
TypeScript, compilación ni dependencias nativas nuevas.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run lint
pnpm pack
```

Si pnpm no está instalado, puedes sustituir `pnpm` por
`npx --yes pnpm@10.32.1`; no hace falta instalar herramientas globales.

Las pruebas ordinarias no usan credenciales reales ni hacen llamadas a
Anthropic. Las pruebas del host aíslan configuración, datos y entorno en
directorios temporales y utilizan SQLite en memoria.

### Qué mantener

- `src/storage.js`: archivo/Keychain, validación, persistencia privada y bloqueo entre procesos.
- `src/credentials.js`: renovación OAuth bajo demanda, concurrencia y recuperación.
- `src/transforms.js`: billing, identidad, instrucciones, Haiku e historial de herramientas.
- `src/index.js`: adaptador nativo de OpenCode y destinos permitidos.
- `src/errors.js`: códigos y mensajes sanitizados.
- `src/compatibility.js`: cabeceras, fallback acotado y restauración de herramientas en streaming.
- `test/*.test.js`: pruebas JS, incluidas renovación, procesos separados y host V2 real con transporte simulado.
- `scripts/diagnostics.mjs`: comparación sanitizada con la referencia y clasificación de errores del probe manual.

El paquete carga `src/index.js` directamente, sin `dist/`, shell, servidor ni
intérprete auxiliar. En macOS utiliza `/usr/bin/security`; las escrituras envían
el secreto por stdin, nunca por argumentos ni variables de entorno. No registra
tokens, prompts ni respuestas OAuth en logs.

## Renovación automática

Al conectar Claudeway o solicitar un modelo, renueva si quedan **cinco minutos o
menos**. Sin caducidad próxima no hace llamadas ni escrituras adicionales. No
necesita temporizadores y no lanza Claude Code para generar una respuesta.

- Una Promise compartida y un bloqueo de archivo coordinan procesos de Claudeway.
- Relee la fuente antes de renovar y antes de escribir; conserva scopes y otros campos.
- La petición OAuth tiene un destino fijo, timeout y redirecciones bloqueadas.
- Guarda los tokens nuevos en el mismo archivo/servicio y devuelve el grant al
  callback OAuth de V2. Los archivos se reemplazan atómicamente con permisos privados.
- Un registro `.claudeway-refresh.json` en el directorio seleccionado conserva
  tokens renovados **solo mientras una escritura esté pendiente**, con permisos
  `0600`. Después queda un recibo con hashes, sin tokens. No lo compartas ni borres
  a ciegas si hay una recuperación pendiente.
- Un timeout o respuesta ambigua bloquea la repetición del refresh anterior: podría
  haberse rotado. Puede requerir iniciar sesión de nuevo. Los rechazos explícitos
  transitorios tienen cooldown; los terminales piden reautenticación.

El bloqueo no obliga a Claude Code a coordinarse con nosotros: las relecturas
detectan cambios, pero no garantizan exclusión absoluta frente a otros clientes.
Un fallo antes de persistir la respuesta OAuth tampoco puede recuperarse siempre
después de un cierre del proceso. Keychain rechaza actualizaciones que excedan la
línea segura de `security -i` (4094 bytes), sin truncarlas.
La renovación en Windows queda deshabilitada hasta verificar ACLs privadas para
el registro de recuperación; la lectura de credenciales vigentes sigue disponible.

Existe un probe manual, **fuera de las pruebas ordinarias**:

```sh
node scripts/verify-live.mjs --confirm --max-requests=3
```

Lee credenciales reales y envía una petición mínima con hasta dos reintentos de
compatibilidad. `--max-requests=1` es el valor predeterminado; el presupuesto total
incluye los envíos internos. Cada envío exige Bearer, ausencia de API key, destino
oficial y un máximo de ocho tokens de salida. El probe bloquea redirecciones en su
transporte aislado; no instala ese guard en producción. No renueva tokens ni
escribe sus fuentes. No lo ejecutes sin autorizar expresamente ese uso.
El probe deshabilita expresamente la nueva renovación automática: si el token está
caducado o a sesenta segundos o menos de caducar, se detiene sin escribir.
Su informe incluye diferencias estructurales frente al original: betas ausentes,
presencia de cabeceras y marcadores del cuerpo, sin valores de credenciales,
prompts, identificadores de sesión ni mensajes de error crudos. Los indicadores
no demuestran cuál de las adaptaciones resolvió por sí sola el error anterior.
El probe bloquea peticiones sin Bearer o con una API key inesperada, espera a que
OAuth termine y distingue las etapas de inicialización, credenciales y petición.

## Alternativa: cargar el directorio local

Después de instalar las dependencias, carga el directorio del paquete en la
configuración V2 del proyecto donde quieras probarlo:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/ruta/absoluta/opencode-claudeway"]
}
```

En `/connect`, elige Anthropic y **Claude Code credentials (Claudeway)**.
La selección es explícita: cargar el plugin no lee credenciales, no conecta una
cuenta y no reemplaza automáticamente una API key existente. La importación usa
las APIs públicas de autenticación de V2; OpenCode administra el grant guardado.

El paquete no está publicado en npm y su nombre no está reservado. Se puede
instalar desde GitHub como se indica arriba. Los cambios de este repositorio no
modifican tu configuración global: la instalación ocurre cuando ejecutas
`opencode plugin add` o añades explícitamente la ruta a tu configuración.

## Fuente y límites actuales

- Una fuente: Keychain de macOS o `.credentials.json` de Claude Code.
- Respeta `CLAUDE_CONFIG_DIR`; no enumera otras cuentas ni directorios.
- En macOS, solo utiliza el archivo si no existe el ítem Keychain correspondiente.
- La renovación actualiza la fuente seleccionada de Claude Code; no escribe `auth.json`.
- El modo de diagnóstico sin renovación rechaza el límite de sesenta segundos.
- No incluye multicuenta, routing, proxy, telemetría ni refresco en segundo plano.
- No genera logs de credenciales, prompts ni cuerpos de error.
- Solo adapta peticiones de la conexión Claudeway activa. Conserva las demás conexiones.
- El fallback de errores 400/429 conocidos elimina únicamente betas que estaban
  presentes, con un máximo de dos reintentos por respuesta; no recupera errores 401.

**Cambio de prioridad de instrucciones:** la compatibilidad mueve las instrucciones
de OpenCode desde `system` al primer mensaje de usuario, dejando billing e identidad
en `system`. No es semánticamente equivalente: reduce la prioridad de esas
instrucciones. No modifica las comprobaciones de permisos de OpenCode.

El uso de credenciales de suscripción en clientes no oficiales puede estar
restringido por las condiciones de Anthropic y dejar de funcionar. Las referencias
comunitarias no constituyen una autorización del servicio.

## Retirada

Retira la entrada de `plugins` y recarga OpenCode. Si conectaste una cuenta de
prueba, elimina solo esa cuenta desde la interfaz nativa de OpenCode. No borres
las credenciales de Claude Code. El plugin no mantiene temporizadores ni procesos
persistentes.

## Licencia

MIT. Consulta [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) para la atribución
original y el estado de revisión de dependencias.
