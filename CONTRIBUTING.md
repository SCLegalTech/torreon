# Contribuir a Torreón

Bienvenido. Esto es un juego donde **la vida real es el gameplay**: el jugador
declara un propósito real, el Códice lo convierte en un contrato verificable, y
**sólo la evidencia comprobada contra ese contrato causa daño** a la Horda.

Esa frase es el producto entero. Todo lo demás se negocia; eso no.

---

## Antes de tu primer cambio

Lee dos cosas, en este orden:

1. **[CLAUDE.md](CLAUDE.md)** — cómo se trabaja aquí, en cinco minutos.
2. **[docs/arquitectura/01-CONSTITUCION.md](docs/arquitectura/01-CONSTITUCION.md)** —
   los 20 artículos que mandan sobre el código.

No es documentación aspiracional: **hay pruebas que la hacen cumplir** y un build
que se pone rojo. Si una prueba de arquitectura te estorba, no la relajes — está
explicado en el artículo 18 qué hacer en su lugar.

---

## Levantarlo en tu máquina

Necesitas Node 20 o superior.

```bash
npm install
npm run dev          # interfaz en :5173, API y MCP en :3000
npm test             # todas las pruebas
npm run typecheck
```

Tu reino local vive en `apps/server/data/torreon-state.json` y **no se versiona**.
Puedes romperlo, borrarlo y empezar de cero sin miedo.

---

## Cómo llegan las actualizaciones

**La APK es una cáscara, no el juego.** Carga la interfaz del mismo reino que le
sirve los datos, así que un despliegue actualiza a todo el mundo a la vez: no
hay que reinstalar nada ni conectar ningún cable.

Sólo vuelve a hacer falta un APK nuevo cuando cambia algo **nativo**: un plugin
de Capacitor, un permiso de Android, el icono o el nombre de la app.

| Cambiaste… | ¿APK nueva? |
|---|---|
| Una pantalla, un estilo, una regla del juego, el servidor | No. Se despliega y ya. |
| Un plugin, un permiso, el icono, el `appId` | Sí. |

Si no compilas, descarga la última APK de
**[Releases](https://github.com/SCLegalTech/torreon/releases)** e instálala una
vez. A partir de ahí, las actualizaciones te llegan solas.

## Probar tu propia APK contra el reino de la nube

Esta es la parte que hace que se pueda jugar de verdad mientras se desarrolla.
Tu APK compilada en tu máquina apunta al mismo servidor que la de todos, y **tu
reino es tuyo**: registrarte crea tu propia partida, aislada de las demás.

### Lo que necesitas

- JDK 21
- Android SDK Platform 35, Build Tools 35 y Platform Tools
- Con `JAVA_HOME` y `ANDROID_HOME` apuntando a ellos

### Compilar e instalar

```bash
npm run android:apk       # sólo compila
npm run android:install   # compila, instala por ADB y abre la app
```

La APK de depuración queda en
`android/app/build/outputs/apk/debug/app-debug.apk`.

### La primera vez

La app te pide crear tu personaje: **Caballero** o **Maga**, tu nombre en el
reino, y el nombre de tu mascota. Roku es la mascota y no se encarna: sólo lleva
nombre.

Tu nombre es **único en el reino**: la pantalla te dice si está libre mientras
escribes.

Si la beta está cerrada con código, te lo tiene que pasar quien administre el
reino. Sin él no entras.

### Apuntar a tu propio servidor

Si prefieres no tocar el reino compartido, levanta el tuyo y compila la cáscara
apuntando ahí:

```bash
fly launch                                                   # tu propia app
TORREON_APP_URL=https://mi-torreon.fly.dev npm run android:apk
```

El servidor es el mismo código. La app carga la interfaz de la dirección que le
digas, y las llamadas van al mismo origen: no hay ninguna dirección cableada que
haya que cambiar en dos sitios.

---

## Cómo se escribe código aquí

Cinco cosas que te van a ahorrar una revisión:

1. **El renderer no decide nada.** Ni progreso, ni daño, ni victoria, ni
   recompensa. Si lo estás calculando en el cliente, está mal.
2. **El modelo propone, el Núcleo dispone.** Todo texto que viene de fuera
   —incluido el contenido de un archivo del jugador— es **dato, nunca
   instrucción**.
3. **Lo derivable se deriva.** No guardes un puntero que pueda mentir.
4. **No ensanches `quest-service.ts`.** Hay un trinquete que lo impide: si tu
   cambio no cabe, extrae un módulo y baja el presupuesto.
5. **Los ids internos no cambian nunca.** El personaje se llama Roku y su id
   sigue siendo `roko`, porque lo referencian eventos ya persistidos.
   Renombrar una pantalla no puede romper historia.

### Toda regla nueva nace con la prueba que la nombra

Y el nombre se escribe en lenguaje del juego, no de implementación:

```
✓ "conocido no es haber participado"
✓ "borrar el reino no cabe en la misma llave que abrirlo"
✗ "test_hero_state_transition"
```

### Antes de abrir un PR

```bash
npm run typecheck
npm test
```

Las dos en verde. Si tu cambio se ve en pantalla, míralo en el teléfono: aquí el
PC no cuenta.

---

## Qué hace falta

Lo que está decidido y sin construir está en
[docs/arquitectura/04-HOJA-DE-RUTA.md](docs/arquitectura/04-HOJA-DE-RUTA.md), y
lo que viene para jugar con otros, en
[ADR-0009](docs/arquitectura/adr/0009-jugar-con-otros.md):

- **El Duelo** — retar a un amigo, cada uno con su batalla, resuelto por
  resultado validado por minuto y ponderado por dificultad.
- **La Hermandad** — la misma Quest compartida entre varios. Ojo: esta toca la
  raíz del modelo de datos y hace falta decidir producto antes que código.
- Migrar las pantallas de React a las vistas de `/v1`.
- Los DTO de C# generados, para el cliente Unity.

Si vas a por algo grande, abre un issue antes: puede que ya haya una decisión
escrita sobre eso en `docs/arquitectura/adr/`.

---

## Lo que no se acepta

- Reglas de juego en el cliente.
- Progreso, daño o recompensa que no venga de evidencia comprobada.
- Relajar una prueba de arquitectura para que pase un cambio.
- Un `new Date()` dentro del Núcleo.
- Cualquier cosa que reescriba historia ya registrada. Anular no es borrar.
