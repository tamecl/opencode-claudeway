# Compatibilidad — hito 1

Estado: hito 1 bloqueado por autenticación real. No es todavía una migración terminada.

## Versiones fijadas

- OpenCode instalado: `2.0.29` (comprobado con `opencode --version`).
- API del plugin y host SDK de pruebas: `2.0.29`.
- Referencia: `griffinmartin/opencode-claude-auth`, versión `2.2.1`, commit
  `8aad811a4da3813ab3985063e656fed582909780`.
- Entorno local: macOS. Las 14 pruebas pasan con Node `24.12.0` y `25.6.1`.
- Node `22.18.0` no puede cargar el SDK de pruebas por su sintaxis de gestión
  explícita de recursos. Se exige Node `24.12+` para no anunciar ese entorno como compatible.

## Mecanismo público elegido

El plugin registra el método OAuth `claudeway` en la integración `anthropic`
mediante `ctx.integration.transform`. El usuario debe seleccionarlo explícitamente.
El callback importa las credenciales existentes; no inicia otro login OAuth.
OpenCode guarda ese grant en su almacenamiento nativo mediante sus APIs públicas.
No se escribe directamente SQLite ni se sincroniza `auth.json`.

El hook `http.request`, limitado a Anthropic y a la conexión Claudeway activa,
relee la fuente y adjunta su token solamente a `https://api.anthropic.com` en
`/v1/messages` o `/v1/messages/count_tokens`. No modifica conexiones API-key ni
conexiones OAuth registradas por otros métodos.

Se evaluó el método público `external`. Se registra y activa, pero el paquete
nativo Anthropic falla por ausencia de `ANTHROPIC_API_KEY` antes del hook HTTP.
No se introdujeron claves ficticias para esquivar ese fallo: se eligió el método
OAuth nativo, que sí resuelve la autenticación antes del transporte.

## Comprobaciones automatizadas

Las pruebas usan el host SDK real, una base SQLite en memoria, configuración y
directorios temporales, credenciales ficticias y Fetch simulado. Se bloquean las
conexiones externas y se aísla el entorno de los perfiles del usuario. La prueba
de redirecciones utiliza exclusivamente dos servidores fixture en loopback.

- Definición `Plugin.define` y entrada ESM compilada.
- Registro explícito y carga mediante el cargador V2.
- Conexión OAuth nativa con credenciales ficticias.
- Una generación atraviesa el hook HTTP y vuelve como streaming Anthropic.
- El hook cubre los kinds `primary`, `title`, `compaction` y `generate` en pruebas
  unitarias; todavía no se han ejercitado todos con conversaciones reales.
- Rechazo de destinos personalizados antes de leer las credenciales.
- API keys y conexiones ajenas no se modifican.
- Lectura de archivo y Keychain simulado, validación y errores sin contenido secreto.
- El transporte Fetch elimina `Authorization` al seguir un 307 entre dos orígenes
  locales distintos. Ningún token ficticio llega al segundo origen.

## Limitación de seguridad descubierta

OpenCode `2.0.29` reconstruye el Request después del hook HTTP y no conserva
`redirect: "error"`. La prueba con el host real documenta que Fetch recibe
`redirect: "follow"`, aunque el Request devuelto por el plugin diga `"error"`.

Por tanto, la asignación del plugin **no demuestra que las redirecciones estén
bloqueadas**. Se verificó que Fetch sí elimina el bearer al cambiar de origen,
usando el host SDK real y dos servidores locales. Esto no bloquea el seguimiento
ni el reenvío del cuerpo, y no certifica otros runtimes o versiones. Sigue siendo
necesario resolver o acotar esta limitación antes de distribuir el plugin. No se
introdujo un monkey patch ni un proxy de producción para ocultarla.

## Prueba real autorizada

El usuario autorizó explícitamente la lectura de la fuente existente y una
petición mínima, sin renovación ni modificación de las fuentes o configuración
global. Se ejecutó el probe con el host SDK `2.0.29`, una configuración temporal,
SQLite en memoria, `claude-haiku-4-5`, un máximo de ocho tokens de salida y la
política pública de reintentos desactivada.

Resultado sanitizado:

```json
{"version":"2.0.29","success":false,"requests":1,"status":401,"category":"authentication_error","hint":null,"sourceModified":false,"database":"memory"}
```

El 401 demuestra un rechazo real de autenticación, no su causa. No prueba por sí
solo que el token esté revocado, que falten cabeceras beta o que la integración
sea imposible. No se hicieron más envíos para probar combinaciones de cabeceras,
identidad o billing. No se renovaron tokens ni se escribieron sus fuentes.

El probe manual es optativo y requiere confirmación:

```sh
pnpm run build
pnpm run verify:live -- --confirm
```

Ese comando **sí lee credenciales reales y puede consumir uso de la cuenta**.
Nunca se ejecuta desde `pnpm test` ni está autorizado para ejecutarse nuevamente
sin consentimiento. Su salida omite tokens, excepciones crudas y cuerpos de error.

## Puerta pendiente antes de continuar

El plan exige demostrar el recorrido con una cuenta real antes de portar la
renovación y las transformaciones complejas. Esa prueba requiere autorización
explícita y no forma parte de las pruebas ordinarias.

No se ha demostrado que baste con el bearer OAuth sin las adaptaciones de
identidad, billing, betas y herramientas del proyecto de referencia. No se han
copiado preventivamente esas adaptaciones ni prompts de procedencia no verificada.

Quedan pendientes renovación/persistencia, coordinación entre procesos,
recuperación de 401, presupuestos de reintento, transformaciones necesarias,
validación manual y CI en los tres sistemas. Los tokens próximos a caducar se
rechazan explícitamente; este hito no los renueva.

## Matriz actual

| Entorno | Automáticas | Cuenta real |
| --- | --- | --- |
| macOS | Ejecutadas localmente | Intentada: 401, no aprobada |
| Linux | Pendientes | No probada |
| Windows | Pendientes | No probada |

## Fuentes

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/migrate-v1/
- https://opencode.ai/v2/docs/cli/providers/
- Tipos publicados de `@opencode/plugin`, `@opencode/schema` y `@opencode/client` `2.0.29`.
