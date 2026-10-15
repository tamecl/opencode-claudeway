# JavaScript único y renovación OAuth bajo demanda

## Objetivo y autorización

El usuario aprobó JavaScript y validación exclusivamente local. Migrar el núcleo
Python a ESM JavaScript y añadir renovación automática con persistencia en la
fuente seleccionada. No consultar, renovar ni escribir credenciales reales durante
este trabajo. No añadir temporizadores, multicuenta, proxy o fallback a generaciones
del CLI. No modificar configuración global ni publicar el paquete.

JavaScript reutiliza el adaptador y las pruebas existentes sin compilación.
TypeScript aportaría chequeo estático, pero añadiría una cadena de herramientas
que no hace falta para mantener un único lenguaje en este paquete pequeño.

## Componentes y alcance

- `src/storage.js`: sustituye el lector Python. Conserva validación estricta,
  `CLAUDE_CONFIG_DIR`, selección de un solo ítem de Keychain y fallback a archivo
  únicamente cuando ese ítem no existe. Conserva el JSON completo para actualizar
  solo los tres campos OAuth y no destruir scopes u otros metadatos.
- `src/credentials.js`: renovación OAuth, coordinación y recuperación de escritura.
- `src/transforms.js`: traslada la adaptación de cuerpos a JS. Conserva billing,
  prioridad de instrucciones ya advertida, Haiku, alias, `tool_choice`, reparación
  por placeholders y límites. La implementación JS usa directamente sus cadenas
  UTF-16 y SHA-256, manteniendo los vectores de compatibilidad existentes.
- `src/index.js` conserva los contratos de `credentialReader.read(env)` y
  `requestAdapter.transform(body)` usados por el host y los tests. El callback
  OAuth devuelve el grant nuevo a V2; el hook HTTP obtiene credenciales vigentes
  de la misma fuente. Conexiones ajenas siguen intactas.
- Migrar los tests de comportamiento Python a `node:test`; retirar Python y su
  puente después de portar la cobertura. Actualizar scripts, paquete, diagnóstico,
  README y compatibilidad sin borrar los resultados históricos.

## Flujo de credenciales

1. Leer y validar la fuente seleccionada. Si quedan más de cinco minutos de
   validez, devolverla sin red ni escrituras.
2. Si necesita renovación, agrupar solicitudes del mismo origen en una Promise y
   adquirir un bloqueo local entre procesos de Claudeway. Esperar de forma acotada;
   no robar un bloqueo de un proceso vivo ni borrar un bloqueo de dueño desconocido.
3. Releer después de adquirir el bloqueo. La identidad conocida es el locator de
   la fuente (archivo o servicio/cuenta Keychain), no un ID de cuenta Anthropic.
   Si cambiaron sus tokens, reutilizar solo un resultado enlazado por un recibo
   local de renovación de Claudeway (hashes SHA-256 del estado anterior y nuevo).
   Sin ese recibo, abortar como fuente cambiada: no adivinar si fue renovación de
   Claude Code o cambio de cuenta. Una llamada posterior empieza con una lectura
   nueva de la fuente seleccionada. No se introduce descubrimiento multicuenta.
4. Preparar un registro privado y durable de operación en curso antes de la red.
   Hacer un único POST a `https://claude.ai/v1/oauth/token` con contenido
   `application/x-www-form-urlencoded`: `grant_type=refresh_token`,
   `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e` y el refresh token leído.
   Referencia exacta: `opencode-claude-auth` 2.2.1, commit
   `8aad811a4da3813ab3985063e656fed582909780`, `src/credentials.ts`.
   Timeout de quince segundos y `redirect: "error"`. No reintentar automáticamente
   una operación de resultado desconocido. La respuesta debe traer `access_token`
   válido y caducidad verificable: `expires_at` futuro en milisegundos o
   `expires_in` positivo en segundos, calculado con overflow comprobado, sin
   caducidad inventada por defecto. Conservar el refresh anterior únicamente si
   falta `refresh_token`; rechazarlo si está presente pero es inválido.
5. Antes de tocar la fuente, actualizar duraderamente el registro de recuperación
   con los tokens nuevos y el hash del estado anterior. El registro completo se
   sincroniza a disco antes de escribir la fuente. La preparación previa detecta
   permisos y fallos de directorio antes de la red, pero no elimina la ventana
   inevitable entre rotación remota y persistencia local. Si no se logra guardar
   el resultado, conservarlo en memoria, detenerse y marcar resultado incierto;
   no repetir el refresh anterior ni afirmar recuperación garantizada tras crash.
6. Releer y comprobar identidad y tokens anteriores; mezclar los campos nuevos con
   los metadatos actuales. Si la cuenta cambió, no sobrescribirla. Archivo: temporal
   privado, fsync y rename en el mismo directorio, rechazando symlinks. Keychain:
   actualizar el mismo servicio/cuenta, sin ampliar ACLs. Verificar la escritura
   antes de reemplazar el registro de recuperación por un recibo sin tokens. Para
   archivos, sincronizar también el directorio tras rename; para Keychain,
   comprobar el valor leído tras el éxito de la herramienta.
7. Recuperar un registro pendiente antes de cualquier nueva llamada OAuth. Si la
   fuente coincide con el estado anterior, completar la escritura; si ya contiene
   el resultado, sustituirlo por el recibo sin tokens. Ante discrepancias con un
   resultado pendiente, detenerse sin borrar datos. Un registro que solo indica
   operación en curso significa resultado incierto: si la fuente sigue igual,
   pedir reautenticación, no refrescar otra vez; si ya fue reemplazada por nuevas
   credenciales válidas, retirar el marcador sin modificar la fuente. El registro
   no se expone en errores ni logs. Recuperación, comprobaciones, escritura y
   verificación permanecen dentro del mismo bloqueo.

Los rechazos explícitos transitorios usan un cooldown corto en memoria. Un timeout
o fallo de transporte después de iniciar el envío tiene resultado incierto y
conserva el marcador, en vez de asumir que el token anterior sigue siendo válido.
Los terminales piden
iniciar sesión y no se repiten para el mismo refresh token mientras viva el proceso.
El modo de lectura sin renovación conserva el rechazo al límite de sesenta segundos.

## Keychain y límites explícitos

Usar `/usr/bin/security` sin shell, con timeout y salida capturada. Para escribir,
usar `security -i` y enviar el comando correctamente escapado por stdin, nunca el
secreto en argumentos ni entorno. Su parser tiene un límite de línea de 4096 bytes:
rechazar entradas que no caben antes de ejecutarlas, calculando la línea completa
en bytes UTF-8 después del escapado, incluidos argumentos y terminador; comprobar también el tamaño
existente antes de renovar. Una respuesta inesperadamente grande queda protegida
por el registro de recuperación y produce un error accionable, no truncamiento.
No se añaden dependencias nativas ni código Swift/Python.
En Windows la renovación falla de forma explícita hasta verificar ACLs privadas
para el registro; no se pretende que `0600` garantice privacidad en NTFS.

El bloqueo coordina Claudeway, no procesos externos de Claude Code. Las relecturas
reducen carreras, pero Keychain y las escrituras externas no ofrecen una operación
compare-and-swap común: no prometer exclusión absoluta. Si se detecta un cambio,
fallar conservando la recuperación y sin pisar la cuenta nueva.

## Verificación y límites del trabajo

Fixtures únicamente: lectura y validación; selección de backend; campos ajenos
preservados; permisos y symlinks; OAuth válido, inválido, revocado, 429, timeout y
redirecciones; una renovación con llamadas concurrentes y procesos separados;
fuente cambiada; rotación; persistencia fallida y recuperación; comandos Keychain
por stdin con escapes y límites; callback nativo V2 y generación simulada con el
token nuevo. Mantener las regresiones de transformación, streaming y presupuestos.

El probe manual debe conservar por defecto su promesa de solo lectura: llamar al
lector con renovación deshabilitada y bloquear destinos de renovación mediante su
guard de transporte. No ejecutarlo ahora. Comprobar `node --test`, lint,
`git diff --check` y el contenido del paquete sin Python ni herramientas de build.

La limitación de redirecciones del primer envío nativo y la prioridad reducida de
instrucciones siguen fuera de este cambio. Esta tarea no certifica compatibilidad
real de renovación ni conversaciones largas.
