<div align="center">

# Claudeway

**Tu sesión de Claude Code, dentro de OpenCode.**

Integración no oficial con renovación OAuth bajo demanda. Sin API key.

Claudeway es un plugin open source para OpenCode V2 que te permite usar tu suscripción Claude Pro o Max (mediante las credenciales de Claude Code) en lugar de una API key de Anthropic.

[![CI](https://img.shields.io/github/actions/workflow/status/tamecl/opencode-claudeway/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tamecl/opencode-claudeway/actions/workflows/ci.yml)
[![OpenCode 2.0.29](https://img.shields.io/badge/OpenCode-2.0.29-24292f?style=flat-square)](https://opencode.ai/v2/docs/plugins)
[![Estado experimental](https://img.shields.io/badge/estado-experimental-d29922?style=flat-square)](docs/compatibility.md)
[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-3fb950?style=flat-square)](LICENSE)

[English](README.md) · [Instalación](#instalación) · [Renovación](#renovación-automática) · [Seguridad](#seguridad-y-límites) · [Preguntas frecuentes](#preguntas-frecuentes) · [Desarrollo](#desarrollo) · [Guía para agentes](installation.md)

</div>

> [!WARNING]
> **Experimental, no oficial y bajo tu responsabilidad.** La renovación OAuth sigue
> en revisión. OpenCode `2.0.29` todavía impide garantizar el bloqueo de
> redirecciones del primer envío nativo. El uso de credenciales de suscripción en
> clientes no oficiales puede estar restringido por las condiciones de Anthropic.

## Qué ofrece

| Función | Cómo funciona |
| :--- | :--- |
| **Tu suscripción existente** | Utiliza OAuth de Claude Code, no una conexión con API key. |
| **Renovación bajo demanda** | Renueva al usar el modelo, sin temporizadores ni generaciones auxiliares del CLI. |
| **Integración nativa** | Se activa explícitamente en OpenCode V2 y conserva las demás conexiones. |

## Instalación

Necesitas **OpenCode V2** —verificado con `2.0.29`— y una sesión existente en
Claude Code. El paquete se publica en npm como `@tamelabs/opencode-claudeway`,
la cuenta oficial de Tame.

### Con un agente

Copia y pega esta línea en OpenCode:

```text
Install the opencode-claudeway plugin and configure it by following: https://raw.githubusercontent.com/tamecl/opencode-claudeway/main/installation.md
```

La [guía para agentes](installation.md) instala y comprueba el plugin sin leer
credenciales ni hacer consultas a Anthropic. La activación de la cuenta queda en
manos del usuario.

### Manualmente

```sh
opencode plugin add @tamelabs/opencode-claudeway
opencode plugin list
```

OpenCode instala las dependencias y añade el plugin a su configuración **global**.
No necesitas clonar el repositorio, instalar pnpm ni compilar.

Después, dentro de OpenCode:

1. **`/connect`** → Anthropic → **Claude Code credentials (Claudeway)**.
2. Deja activa la cuenta Claudeway.
3. **`/models`** → selecciona tu modelo Claude.

<p align="center">
  <img src="docs/assets/model-picker.png" width="640" alt="Selector de modelos de OpenCode V2 con Claude Fable 5.1, Haiku 5.5, Opus 5.5 y Sonnet 5.5 disponibles mediante Claudeway con una suscripción de Claude">
</p>

> [!IMPORTANT]
> Conectar o usar Claudeway puede renovar tokens y actualizar la fuente de
> credenciales de Claude Code. No copies tokens manualmente ni elijas el método
> API key. Cargar el plugin, por sí solo, no conecta ninguna cuenta.

<details>
<summary><strong>Actualizar, fijar una versión, instalar desde Git o reiniciar el servicio</strong></summary>

Para actualizar solo esta instalación:

```sh
opencode plugin update @tamelabs/opencode-claudeway
```

Para fijar una versión, usa `@tamelabs/opencode-claudeway@0.1.0`. Para probar la
rama principal sin pasar por npm:

```sh
opencode plugin add 'git+https://github.com/tamecl/opencode-claudeway.git#main'
```

Si ya lo instalaste desde Git, SSH o una ruta local, retira esa entrada antes de
añadir la de npm; no mantengas dos copias.

Si el plugin no aparece activo, puedes reiniciar el servicio. Ten en cuenta que
esto puede interrumpir otras sesiones:

```sh
opencode service restart
opencode plugin list
```

</details>

<details>
<summary><strong>Alternativa: cargar el directorio local</strong></summary>

Después de instalar las dependencias del repositorio, añade su ruta a la
configuración V2 del proyecto donde quieras probarlo:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/ruta/absoluta/opencode-claudeway"]
}
```

Luego activa Claudeway mediante `/connect`, como en la instalación manual.
Usa el directorio local **o** el paquete publicado, no ambos.

</details>

## Renovación automática

Al conectar Claudeway o solicitar un modelo, renueva si quedan **cinco minutos o
menos** de validez. Sin caducidad próxima, no hace llamadas ni escrituras
adicionales.

- **Coordinación:** una Promise compartida y un bloqueo de archivo coordinan
  procesos de Claudeway. La fuente se relee antes de renovar y antes de escribir.
- **Persistencia:** conserva scopes y otros metadatos, actualiza la misma fuente
  y devuelve el grant al callback OAuth de V2. Los archivos se reemplazan de forma
  atómica con permisos privados.
- **Recuperación:** `.claudeway-refresh.json` conserva los tokens nuevos solo si
  hay una escritura pendiente, con permisos POSIX `0600`. Después queda un recibo
  con hashes, sin tokens. **No lo compartas ni lo borres a ciegas.**
- **Fallos acotados:** la petición OAuth tiene destino fijo, timeout y redirecciones
  bloqueadas. Los rechazos transitorios tienen cooldown; los terminales piden
  reautenticación. Un resultado incierto no repite el refresh token anterior.

Claude Code no está obligado a respetar nuestro bloqueo. Las relecturas reducen
carreras, pero no garantizan exclusión absoluta frente a otros clientes ni
recuperación tras un cierre antes de persistir la respuesta OAuth.

### Token propio (evita choques con Claude Code)

Claudeway y Claude Code comparten un refresh token rotatorio, así que pueden
chocar al renovar (síntoma: *OAuth renewal is rate-limited*). Para evitarlo,
guarda un token anual independiente (`claude setup-token`) en el ítem de Keychain
`Claudeway-token` (macOS) o en `~/.claude/.claudeway-token` con permisos `0600`
(Linux). Si existe, Claudeway lo usa tal cual: **no lee ni renueva** las
credenciales de Claude Code. Un 401 pide repetir `setup-token`. Pasos en
[installation.md](installation.md#optional-dedicated-token-no-renewal-conflicts-with-claude-code).
No compatible con Windows.

## Seguridad y límites

### Qué está comprobado

| Recorrido | Evidencia actual |
| :--- | :--- |
| Generación real con suscripción | **Funcionando** en OpenCode `2.0.29`, sin API key. |
| Implementación JS y renovación | Verificadas con fixtures y el host SDK V2; **sin renovación real** en esta etapa. |
| macOS | Generación real con Haiku 5.5, Sonnet 5.5 y Opus 5.5. Pruebas locales ejecutadas; Keychain simulado. |
| Linux (Ubuntu) | Generación real con Haiku 5.5, Sonnet 5.5, Opus 5.5 y Fable 5.1. Renovación real y pruebas automáticas pendientes. |
| Windows | Pendiente. La renovación está deshabilitada hasta verificar ACLs privadas. |

### Límites que debes conocer

- **Redirecciones:** el host puede seguir el primer envío y reenviar el cuerpo.
  Bloquear redirecciones en OAuth o en el verificador no corrige ese transporte.
- **Prioridad de instrucciones:** la compatibilidad mueve instrucciones desde
  `system` al primer mensaje de usuario, reduciendo su prioridad. No es equivalente
  a mantenerlas en `system`; las comprobaciones de permisos de OpenCode no cambian.
- **Keychain:** se rechazan actualizaciones que excedan la línea segura de
  `security -i` —4094 bytes—, sin truncarlas.
- **Fuente única:** respeta `CLAUDE_CONFIG_DIR`; no descubre otras cuentas. En macOS
  solo usa el archivo si no existe el ítem Keychain correspondiente.
- **Sin registros de secretos:** no registra tokens, prompts ni cuerpos de error.
  Las escrituras Keychain viajan por stdin, nunca por argumentos ni entorno.
- **Alcance limitado:** no incluye multicuenta, routing, proxy, telemetría ni
  refresco en segundo plano. El fallback de 400/429 conocidos quita solo betas
  presentes, con hasta dos reintentos; no recupera errores 401.

La renovación modifica la fuente seleccionada de Claude Code, no `auth.json`.
El uso de credenciales de suscripción en clientes no oficiales puede estar
restringido por las condiciones de Anthropic y dejar de funcionar.

Consulta el [informe de compatibilidad](docs/compatibility.md) para los resultados,
el historial de diagnóstico y las limitaciones completas.

## Preguntas frecuentes

**¿Cómo uso mi suscripción Claude Pro o Max en OpenCode?**
Instala Claudeway (`opencode plugin add @tamelabs/opencode-claudeway`), conecta
**Claude Code credentials (Claudeway)** en `/connect` y elige un modelo en
`/models`. Necesitas una sesión de Claude Code existente.

**¿Necesito una API key de Anthropic?**
No. Claudeway usa las credenciales OAuth de Claude Code, no una API key.

**¿Qué modelos funcionan?**
Probado con generación real en OpenCode `2.0.29`: Claude Haiku 5.5, Sonnet 5.5 y
Opus 5.5 en macOS, y además Fable 5.1 en Ubuntu.

**¿Qué sistemas operativos soporta?**
macOS y Linux. En Windows la renovación está deshabilitada hasta verificar ACLs
privadas.

**¿Es gratis y open source?**
Sí, licencia MIT. Necesitas tu propia suscripción de Claude.

**¿Funciona con OpenCode V1?**
No. Claudeway es solo para OpenCode V2.

**¿En qué se diferencia de opencode-claude-auth?**
Claudeway es un proyecto independiente para OpenCode V2, basado en una migración
selectiva de [opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth).
Agrega renovación OAuth bajo demanda con bloqueo de archivo, recuperación ante
escrituras interrumpidas y un [token dedicado](#token-propio-evita-choques-con-claude-code)
opcional para no chocar con Claude Code.

**¿Lo permite Anthropic?**
Es no oficial. Usar credenciales de suscripción en clientes no oficiales puede
estar restringido por las condiciones de Anthropic y podría dejar de funcionar.

## Desarrollo

**Node `24.12+` · pnpm `10.32.1` · OpenCode `2.0.29`**

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run lint
pnpm pack
```

Si no tienes pnpm, sustituye `pnpm` por `npx --yes pnpm@10.32.1`.
El paquete carga `src/index.js` directamente, sin `dist/` ni intérprete auxiliar.
Las pruebas ordinarias no usan credenciales reales ni llaman a Anthropic: aíslan
el entorno y utilizan fixtures, SQLite en memoria y transporte simulado.

<details>
<summary><strong>Mapa del proyecto</strong></summary>

| Archivo | Responsabilidad |
| :--- | :--- |
| [`src/index.js`](src/index.js) | Integración V2 y destinos permitidos. |
| [`src/storage.js`](src/storage.js) | Archivo/Keychain, validación, persistencia y bloqueo. |
| [`src/credentials.js`](src/credentials.js) | Renovación OAuth, concurrencia y recuperación. |
| [`src/transforms.js`](src/transforms.js) | Billing, identidad, instrucciones, Haiku y herramientas. |
| [`src/compatibility.js`](src/compatibility.js) | Cabeceras, fallback y streaming. |
| [`src/errors.js`](src/errors.js) | Códigos y mensajes sanitizados. |
| [`test/`](test) | Pruebas de comportamiento y del host V2. |
| [`scripts/diagnostics.mjs`](scripts/diagnostics.mjs) | Comparación sanitizada y diagnóstico del probe manual. |

</details>

<details>
<summary><strong>Prueba real optativa — requiere autorización</strong></summary>

Este verificador queda **fuera de las pruebas ordinarias**. Lee credenciales reales
y puede consumir uso de la cuenta. No lo ejecutes sin autorizar expresamente ese uso.

```sh
node scripts/verify-live.mjs --confirm --max-requests=3
```

- Permite una petición mínima y hasta dos reintentos, dentro del presupuesto total.
  El valor predeterminado de `--max-requests` es `1`; cada envío tiene un máximo de
  ocho tokens de salida y exige Bearer, ausencia de API key y destino oficial.
- **No renueva tokens ni escribe sus fuentes.** Deshabilita la renovación automática
  y rechaza credenciales a sesenta segundos o menos de caducar.
- Bloquea redirecciones en su transporte aislado, no en el plugin de producción.
- Espera que OAuth termine y distingue inicialización, credenciales y petición.
  El informe omite tokens, prompts, IDs de sesión y errores crudos; sus diferencias
  estructurales no demuestran qué adaptación resolvió por sí sola el error anterior.

</details>

## Retirada

```sh
opencode plugin remove @tamelabs/opencode-claudeway
```

Si conectaste una cuenta de
prueba, elimina solo esa cuenta desde la interfaz nativa; **no borres las
credenciales de Claude Code**. El plugin no mantiene temporizadores ni procesos
persistentes.

## Créditos y licencia

Proyecto independiente basado en una migración selectiva de
[opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth), no en
una modificación de ese repositorio. Las referencias comunitarias no constituyen
una autorización del servicio.

[MIT](LICENSE) · [Atribuciones y dependencias](THIRD_PARTY_NOTICES.md)
