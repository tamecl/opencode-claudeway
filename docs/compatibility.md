# Compatibilidad — hito 1

Estado: código y pruebas en **JavaScript único**, con renovación OAuth bajo demanda
verificada mediante fixtures. La generación real histórica de la versión híbrida
obtuvo **HTTP 200 y `OK`**, sin API key. No se han usado credenciales reales durante
la migración a JS ni se ha validado una renovación real. Sigue siendo experimental:
faltan sesiones largas, herramientas reales y resolver las redirecciones del host.
Los 401/400 de abajo son resultados históricos anteriores a la adaptación.

## Versiones fijadas

- OpenCode instalado: `2.0.29` (comprobado con `opencode --version`).
- API del plugin y host SDK de pruebas: `2.0.29`.
- Referencia: `griffinmartin/opencode-claude-auth`, versión `2.2.1`, commit
  `8aad811a4da3813ab3985063e656fed582909780`.
- Entorno local: macOS. La versión TypeScript original pasó 14 pruebas con Node
  `24.12.0` y `25.6.1`. La etapa híbrida histórica se documenta más abajo.
- Node `22.18.0` no puede cargar el SDK de pruebas por su sintaxis de gestión
  explícita de recursos. Se exige Node `24.12+` para no anunciar ese entorno como compatible.

## Implementación actual: JavaScript y renovación

El usuario aprobó eliminar Python y validar solo con fixtures. El paquete carga
`src/index.js` directamente y usa JavaScript ESM, `node:test` y APIs integradas de
Node, sin compilación, intérprete auxiliar ni dependencias nuevas. La etapa Python
anterior aprobó 67 pruebas (25 Python y 42 JS) y produjo la generación real que se
documenta más abajo; esos resultados no certifican por sí solos la versión actual.

`src/storage.js` conserva la validación, el hash exacto de `CLAUDE_CONFIG_DIR`, la
preferencia por un solo ítem Keychain y el fallback a archivo solo cuando falta
ese ítem. Preserva el JSON completo y actualiza únicamente los campos OAuth.
Rechaza symlinks; las escrituras a archivo usan temporal privado, fsync y rename.
Keychain usa `/usr/bin/security`, sin shell, con dos segundos y un MiB de captura.
Las escrituras viajan por stdin (`security -i`), nunca con secretos en argv o env.
La línea completa escapada se limita a 4094 bytes; no se trunca ni amplía ninguna ACL.

`src/credentials.js` renueva al necesitar credenciales con cinco minutos o menos
de validez. Una Promise agrupa llamadas y un bloqueo privado coordina procesos de
Claudeway; se relee la fuente al adquirirlo. Los recibos sin tokens permiten
reconocer renovaciones propias. Sin esa prueba no se confunde un token diferente
con una renovación legítima: se aborta conservadoramente como fuente cambiada.

La renovación hace un único POST a `https://claude.ai/v1/oauth/token`, con el
client ID público y formato form de la referencia, timeout de quince segundos y
redirecciones bloqueadas. Valida tokens y caducidad sin inventar una por defecto.
Los rechazos transitorios explícitos tienen cooldown; los terminales no se repiten
con el mismo refresh token mientras viva el proceso. No lanza generaciones del CLI.

Antes de enviar se persiste un marcador de operación; tras validar la respuesta,
un registro privado `.claudeway-refresh.json` guarda los tokens nuevos antes de
actualizar la fuente. Permisos POSIX `0600`, mismo directorio y ninguna salida en
logs. Tras verificar el guardado se reemplaza por un recibo de hashes sin tokens.
Una escritura fallida conserva la recuperación; al reintentar se termina esa
escritura sin repetir OAuth. Un timeout/resultado incierto bloquea reutilizar el
refresh anterior y puede requerir reautenticación. El intervalo entre rotación
remota y guardado local no permite garantizar recuperación absoluta tras un crash.

Claude Code no está obligado a respetar nuestro bloqueo. Las relecturas detectan
cambios de cuenta pero no ofrecen compare-and-swap con procesos externos. No se
debe borrar o compartir a ciegas un registro con tokens pendientes. La renovación
en Windows falla explícitamente con `unsupported-platform` hasta verificar ACLs
privadas; sigue disponible la lectura de credenciales vigentes sin escritura.

`src/transforms.js` sustituye las adaptaciones Python conservando sus vectores y
comportamiento. `src/compatibility.js` mantiene cabeceras, fallback y streaming.
El lector público conserva un modo `{ renew: false }`: no consulta el registro,
no escribe y rechaza credenciales a sesenta segundos o menos de caducar.

La validación local actual usa Node `25.6.1` en macOS: 84 pruebas JS, lint limpio
y empaquetado verificado. Las otras plataformas siguen
pendientes. Las pruebas ordinarias nunca acceden al Keychain ni al servicio reales.

## Mecanismo público elegido

El plugin registra el método OAuth `claudeway` en la integración `anthropic`
mediante `ctx.integration.transform`. El usuario debe seleccionarlo explícitamente.
El callback obtiene las credenciales existentes y las renueva si es necesario;
no inicia otro login OAuth.
OpenCode guarda ese grant en su almacenamiento nativo mediante sus APIs públicas.
No se escribe directamente SQLite ni se sincroniza `auth.json`.

El hook `http.request`, limitado a Anthropic y a la conexión Claudeway activa,
obtiene credenciales vigentes de la fuente y adjunta su token solamente a `https://api.anthropic.com` en
`/v1/messages` o `/v1/messages/count_tokens`. No modifica conexiones API-key ni
conexiones OAuth registradas por otros métodos.

Se evaluó el método público `external`. Se registra y activa, pero el paquete
nativo Anthropic falla por ausencia de `ANTHROPIC_API_KEY` antes del hook HTTP.
No se introdujeron claves ficticias para esquivar ese fallo: se eligió el método
OAuth nativo, que sí resuelve la autenticación antes del transporte.

## Comprobaciones automatizadas

Las pruebas de integración usan el host SDK real, una base SQLite en memoria,
configuración y directorios temporales, credenciales ficticias y Fetch simulado. Se bloquean las
conexiones externas y se aísla el entorno de los perfiles del usuario. La prueba
de redirecciones utiliza exclusivamente dos servidores fixture en loopback.

- Definición `Plugin.define` y entrada ESM JavaScript sin compilación.
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
- Adaptación de cabeceras/cuerpo, vectores de hashing compatibles con UTF-16 de JS,
  limpieza de `effort` en Haiku y conservación de bloques de thinking.
- Herramientas con alias reversibles, nombres largos, colisiones rechazadas,
  `tool_choice` e historial con resultados huérfanos o ausentes.
- Streaming SSE fragmentado, cancelación y conservación de argumentos y firmas.
- Host real con secuencia simulada 400 → 400 → 200: tres envíos contados, mismo
  cuerpo, betas distintas y restauración del nombre de herramienta del fixture.
- Guard de transporte que limita todos los envíos del probe, incluso concurrentes,
  y bloquea redirecciones, API keys, destinos ajenos y presupuestos inválidos.
- Renovación: rotación, límites de caducidad, concurrencia en un proceso y procesos
  separados, cooldown, rechazo terminal y resultados inciertos que no se repiten.
- Persistencia fallida, registro privado, recuperación y cambio concurrente de cuenta.
- Keychain simulado: selección exacta, comandos por stdin, escapes y rechazo de
  tamaños excesivos, incluso si el token nuevo crece inesperadamente.
- Host V2 con fuente ficticia caducada: renueva, guarda el grant nativo y genera
  usando el token nuevo, sin red externa ni credenciales reales.

## Adaptaciones aplicadas

Solo afectan a la conexión OAuth cuyo método es `claudeway`. El hook de petición
valida el destino antes de leer credenciales y adapta el JSON con `src/transforms.js`.

- Añade las ocho betas base de la referencia y las específicas de modelos con
  soporte de esfuerzo. Haiku elimina `output_config.effort`, `thinking.effort` y la
  beta de esfuerzo, sin quitar otros campos.
- Añade cabeceras de cliente y UUIDs; conserva cabeceras nativas ajenas y elimina
  `x-api-key` y cabeceras de longitud/codificación invalidadas al reescribir el cuerpo.
- Calcula el marcador billing de la referencia sobre el texto original del primer
  usuario, antes de trasladar instrucciones; lo coloca en `system[0]` y separa la
  identidad de Claude Code en otro bloque, sin duplicar `cache_control`.
- Mueve las otras instrucciones al primer mensaje de usuario. **Esto reduce su
  prioridad; no es equivalente a conservarlas en `system`.** El mecanismo de
  permisos de OpenCode no cambia. Estos marcadores no convierten al plugin en
  cliente oficial ni constituyen una autorización de Anthropic.
- Prefija herramientas personalizadas y llamadas históricas, adapta `tool_choice`
  y restaura solo nombres conocidos en respuestas JSON/SSE; no sustituye texto de
  argumentos ni firmas. Conserva los nombres de herramientas de servidor.
- Elimina resultados huérfanos y añade placeholders `is_error` para resultados
  ausentes. No borra llamadas del asistente ni bloques de thinking.
- Ante errores 400/429 reconocidos de extra usage/contexto, el hook de respuesta
  puede repetir como máximo dos veces, quitando primero `context-1m-2025-08-07` y
  después `interleaved-thinking-2025-05-14`, **solo si estaban presentes**. Recuerda
  exclusiones por modelo durante la vida del plugin. No repite peticiones idénticas.
  Los reintentos internos bloquean redirecciones y tienen un timeout de quince
  segundos. Ese fallback no renueva tokens ni recupera errores 401; la renovación
  es independiente y ocurre al obtener credenciales.

La API V2 de consultas transitorias no aplica la política del hook `retry`; por
eso este fallback utiliza el hook `http.response`. El hook `retry` evita que el
bucle principal repita indefinidamente esos errores específicos. No se añadió
proxy ni parche global de Fetch en el plugin de producción.

Límites deliberados: JSON de petición/adaptación de hasta 16 MiB, credenciales de
hasta un MiB y eventos SSE individuales acotados. Se rechazan
entradas inválidas o alias ambiguos en vez de reenviarlos silenciosamente.

## Diagnóstico histórico del 401 frente al original

`scripts/diagnostics.mjs` compara una petición con la estructura del original
`2.2.1`, commit `8aad811a4da3813ab3985063e656fed582909780`. Usa sus ocho betas
base, sin overrides por modelo, las cabeceras de cliente y marcadores del cuerpo.
Es una comparación de referencia, **no una lista de requisitos oficiales**.

Antes de portar las adaptaciones, las pruebas offline con el host V2 real y Fetch
simulado mostraban estas diferencias. Hoy las pruebas exigen que estén resueltas:

| Comprobación | Resultado |
| --- | --- |
| Bearer y ausencia de `x-api-key` | Correctos |
| `anthropic-version: 2023-06-01` y `?beta=true` | Ya los aporta V2 |
| Betas base de la referencia | Faltan siete; solo coincide `interleaved-thinking-2025-05-14` |
| `x-app` e identificador de sesión de Claude Code | Ausentes |
| Marcador billing en el primer bloque `system` e identidad separada | Ausentes |

Entre las diferencias están `oauth-2025-04-20` y `claude-code-20250219`. El informe
no implica que baste con añadirlas ni que todas las otras betas sean necesarias.
El marcador billing del original está en el cuerpo, no en una cabecera HTTP.
En esa fase los fixtures solo comprobaban la estructura. Ahora se prueba también
el algoritmo del marcador contra vectores de JS; no es una firma oficial validada.

En una ejecución manual autorizada, el campo `request` del resultado incluye
`headers.missingBaseBetas`, `headers.missingClientHeaders` e indicadores booleanos
de formato y marcadores del cuerpo. Solo devuelve nombres conocidos y datos
derivados; no emite URLs, cabeceras arbitrarias, tokens, prompts ni IDs de cliente.
El hook inspecciona clones: no consume ni modifica la petición o respuesta.
Se comprueba offline que el resumen del hook coincide con la entrada del Fetch
nativo simulado. No es una captura de tráfico real ni valida redirecciones.

El probe conserva las categorías de error permitidas y amplía `hint` con
`invalid-api-key`, `invalid-token`, `revoked`, `beta-header` e `insufficient-scope`,
además de `expired`, `oauth-not-supported`, `claude-code-only` y `extra-usage`.
Son clasificaciones heurísticas de mensajes conocidos, no mensajes del servidor.
Si no reconoce el error, `hint` sigue siendo `null`: un 401 por sí solo no
se clasifica como una cabecera ausente. Los errores locales `expired` y `reader`
también se conservan como códigos sanitizados.

En esa fase no se habían cambiado cabeceras ni inyectado identidad/billing. Los
intentos históricos y la corrección del probe se documentan más abajo. Ahora
estas adaptaciones sí están aplicadas. La renovación se añadió después y se
deshabilita expresamente en el probe. La prueba
manual continúa exigiendo autorización explícita, ocho tokens de salida por
petición y un único paso por el hook HTTP hacia `/v1/messages` oficial. Su guard
de transporte cuenta también los reintentos internos dentro del total aprobado.
La limitación de redirecciones descrita a continuación sigue vigente.

El probe ahora rechaza `missing-bearer` y `unexpected-api-key` antes de permitir
el transporte y sin consumir el presupuesto del intento autenticado. Recomprueba
el presupuesto después del análisis asíncrono para bloquear solicitudes
concurrentes. Espera el estado OAuth `complete`, sondeando solo el SDK local cada
50 ms durante un máximo de cinco segundos; los fallos se clasifican como
`oauth-incomplete` u `oauth-timeout` sin propagar sus mensajes.

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

El probe independiente sí instala temporalmente un guard de Fetch **antes** de
importar el SDK: fuerza `redirect: "error"` tanto en el primer envío como en los
reintentos, valida cada destino y cuenta cada envío. Las pruebas ejercitan este
recorrido. Esto protege la validación manual, no corrige el transporte de producción.

## Pruebas reales autorizadas

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

### Nuevo diagnóstico: petición de inicialización sin Bearer

Un intento posterior autorizado, con el diagnóstico habilitado, devolvió estos
campos sanitizados (resumen, no salida completa):

```json
{"requests":1,"status":401,"category":"authentication_error","hint":null,"bearer":false,"sourceModified":false}
```

Se reprodujo offline un fallo del probe con su configuración exacta: configurar
los timeouts de Anthropic activa el proveedor V2, y la generación utilizada para
inicializar plugins puede llegar al transporte **antes de conectar una cuenta**.
El test anterior no configuraba esos timeouts y no detectaba ese recorrido.
Por tanto, el 401 observado **no demuestra que Anthropic rechace un token de
suscripción válido**. El Bearer ausente debe resolverse antes de atribuirlo a
betas o restricciones del servicio.

La regresión prueba ahora la misma configuración con credenciales ficticias:
cero lecturas y cero envíos durante el bootstrap, conexión OAuth completada y
un único envío autenticado al Fetch simulado. El campo `stage` del resultado
distingue `initialize`, `credentials` y `request`, y el resumen del bootstrap se
descarta antes de importar la cuenta. Tras corregirlo se aprobaron las 44 pruebas
offline. Solo después de una nueva autorización explícita se realizó el intento
descrito a continuación.

### Intento autorizado con el probe corregido

El siguiente intento llegó a la etapa `request` con Bearer correctamente formado y sin
`x-api-key`. Resultado sanitizado resumido:

```json
{"stage":"request","success":false,"requests":1,"status":400,"category":"invalid_request_error","hint":"extra-usage","bearer":true,"apiKeyAbsent":true,"sourceModified":false}
```

En este intento ya no apareció el 401. El servidor devolvió un error de petición,
sin una generación exitosa. El indicio `extra-usage` no demuestra por sí solo que
la suscripción esté agotada: también queda pendiente distinguir restricciones de
cuenta/modelo de la forma de la petición. En ese intento seguían presentes las
diferencias de betas, cabeceras de cliente e identidad/billing. No se había
demostrado cuál causaba el 400.

Se hizo un único intento autorizado con el probe corregido, sin renovar tokens
ni escribir sus fuentes. No se probaron combinaciones adicionales de cabeceras,
cuerpo, modelos ni opciones de billing. Otro intento requiere autorización nueva.

### Validación después de aplicar compatibilidad — 2026-10-15

Se autorizó aplicar las adaptaciones y realizar hasta tres peticiones reales en
total, con un máximo de ocho tokens de salida por petición, sin renovar tokens ni
modificar sus fuentes. Después de aprobar las 67 pruebas locales se ejecutó:

```sh
node scripts/verify-live.mjs --confirm --max-requests=3
```

Resultado sanitizado resumido:

```json
{"version":"2.0.29","stage":"request","success":true,"requests":1,"transportRequests":1,"maxRequests":3,"status":200,"category":null,"hint":null,"sourceModified":false,"database":"memory"}
```

El texto generado fue `OK`. Se utilizó `claude-haiku-4-5`, Bearer OAuth y ninguna
API key. El diagnóstico no encontró betas base ni cabeceras de cliente ausentes,
y confirmó billing en primer lugar, identidad separada y herramientas prefijadas.
No hubo reintentos: solo se consumió una de las tres peticiones permitidas. Se
detuvo la validación al tener éxito, sin probar otras combinaciones ni modelos.

Esto demuestra una generación mínima mediante la suscripción en este entorno y
momento, **no** cuál adaptación individual resolvió el 400, ni compatibilidad
completa con sesiones largas o ejecución real de herramientas.

El probe manual es optativo y requiere confirmación. Por defecto permite un solo envío:

```sh
pnpm run verify:live -- --confirm
```

Ese comando **sí lee credenciales reales y puede consumir uso de la cuenta**.
Nunca se ejecuta desde `pnpm test` ni está autorizado para ejecutarse nuevamente
sin consentimiento. Su salida omite tokens, excepciones crudas y cuerpos de error.
El lector recibe el entorno original autorizado; el host mantiene su entorno y
almacenamiento aislados. Las migraciones no alteran los resultados históricos;
el uso de la suscripción ya tiene una generación exitosa, sin certificar su
estabilidad futura. Otro intento requiere autorización nueva.

## Pendiente antes de distribuir

La generación mínima real ya está demostrada con las adaptaciones. Quedan
pendientes la limitación de redirecciones de producción, conversaciones largas,
ejecución real de herramientas, revisión de condiciones del servicio, licencias
y CI en los sistemas objetivo. La renovación/persistencia se implementó y probó
localmente, pero no se autorizó ni ejecutó una renovación real en esta etapa.
La recuperación automática de un error 401 de generación sigue fuera de alcance.

## Matriz actual

| Entorno | Automáticas | Cuenta real |
| --- | --- | --- |
| macOS | 84 pruebas JS, renovación simulada | Haiku histórico: HTTP 200 y `OK`; renovación real pendiente |
| Linux | Pendientes | No probada |
| Windows | Pendientes; renovación deshabilitada hasta verificar ACLs | No probada |

## Fuentes

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/migrate-v1/
- https://opencode.ai/v2/docs/cli/providers/
- Tipos publicados de `@opencode/plugin`, `@opencode/schema` y `@opencode/client` `2.0.29`.
- https://github.com/griffinmartin/opencode-claude-auth/blob/8aad811a4da3813ab3985063e656fed582909780/src/index.ts
- https://github.com/griffinmartin/opencode-claude-auth/blob/8aad811a4da3813ab3985063e656fed582909780/src/model-config.ts
- https://github.com/griffinmartin/opencode-claude-auth/blob/8aad811a4da3813ab3985063e656fed582909780/src/transforms.ts
- https://github.com/griffinmartin/opencode-claude-auth/blob/8aad811a4da3813ab3985063e656fed582909780/src/credentials.ts
- Interfaz y límites de `security -i`: https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c
