# Claudeway — opencode-claudeway

Plugin no oficial y propio para utilizar credenciales existentes de Claude Code
en OpenCode V2. Basado en una migración selectiva de
[opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth), no en
una modificación de ese repositorio.

**Estado: hito 1 bloqueado por autenticación. No está listo para uso normal.** La
integración funciona con el host V2 real y un transporte simulado, pero una prueba
autorizada con Anthropic devolvió **401 `authentication_error`**. No renueva tokens ni adapta todavía las peticiones
para compatibilidad con Claude Code. Existe además una limitación de
redirecciones del host que no permite garantizar su bloqueo; consulta
[`docs/compatibility.md`](docs/compatibility.md).

## Desarrollo local

OpenCode objetivo: `2.0.29`. Node para desarrollo: `24.12+`. pnpm: `10.32.1`.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm run lint
pnpm pack
```

Si pnpm no está instalado, puedes sustituir `pnpm` por
`npx --yes pnpm@10.32.1`; no hace falta instalar herramientas globales.

Las pruebas ordinarias no usan credenciales reales ni hacen llamadas a
Anthropic. Las pruebas del host aíslan configuración, datos y entorno en
directorios temporales y utilizan SQLite en memoria.

Existe un probe manual `pnpm run verify:live -- --confirm`, **fuera de las pruebas
ordinarias**: lee credenciales reales y envía una petición mínima, sin renovar
tokens ni escribir sus fuentes. No lo ejecutes sin autorizar expresamente ese uso.

## Configuración local para la prueba de compatibilidad

Después de compilar, carga el directorio del paquete en la configuración V2
del proyecto donde quieras probarlo:

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

No hay instalación publicada: el paquete es privado y el nombre no está reservado.
No se ha modificado tu configuración global ni instalado el plugin en tu cuenta.

## Fuente y límites actuales

- Una fuente: Keychain de macOS o `.credentials.json` de Claude Code.
- Respeta `CLAUDE_CONFIG_DIR`; no enumera otras cuentas ni directorios.
- En macOS, solo utiliza el archivo si no existe el ítem Keychain correspondiente.
- No escribe en las fuentes de Claude Code ni en `auth.json`.
- Rechaza tokens caducados o a menos de 60 segundos de caducar.
- No incluye multicuenta, routing, proxy, telemetría ni refresco en segundo plano.
- No genera logs de credenciales, prompts ni cuerpos de error.

El uso de credenciales de suscripción en clientes no oficiales puede estar
restringido por las condiciones de Anthropic y dejar de funcionar. Las referencias
comunitarias no constituyen una autorización del servicio.

## Retirada

Retira la entrada de `plugins` y recarga OpenCode. Si conectaste una cuenta de
prueba, elimina solo esa cuenta desde la interfaz nativa de OpenCode. No borres
las credenciales de Claude Code. El plugin no mantiene temporizadores ni procesos.

## Licencia

MIT. Consulta [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) para la atribución
original y el estado de revisión de dependencias.
