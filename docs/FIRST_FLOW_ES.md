# Primer flujo: pedido creado hacia fulfillment

## La historia de negocio

Nébula Commerce recibe un pedido nuevo. En ese momento su sistema manda un
**aviso automático** llamado `order.created`; ese aviso crea una ejecución en
IntegrationHub, que debe entregarlo a la API que prepara el envío. Si esa API está
temporalmente caída, el pedido no se pierde ni se procesa dos veces: la persona
operadora puede ver qué pasó y reintentar únicamente la entrega fallida.

En términos técnicos, ese aviso automático llega mediante un *webhook*. En
términos de negocio sólo significa: «se creó un pedido; comienza este flujo».

## Cómo leer los estados

- **En cola:** el aviso ya está guardado y espera turno.
- **Procesando:** el primer intento está ocurriendo en ese momento. Debe durar
  sólo unos segundos y todavía no se permite repetirlo, para no mandar el pedido
  dos veces.
- **Entregado:** el destino lo aceptó. No hace falta otro intento.
- **Se puede reintentar:** el intento terminó con un problema temporal, como un
  `503` o un tiempo de espera agotado. Ahora sí puede comenzar el intento 2.
- **Necesita corrección:** el destino rechazó la solicitud de forma permanente,
  por ejemplo con un `401`. Repetirla sin corregir la conexión volvería a fallar.

## Reglas operativas visibles en la demostración

- **Operadora:** puede reintentar fallos temporales y cerrar un caso fallido con
  un motivo.
- **Administradora:** además puede reemplazar de forma segura la credencial de
  un proveedor. IntegrationHub ejecuta enseguida una prueba autenticada y sin
  efectos de negocio; sólo si el proveedor la acepta habilita el reproceso del
  `401`.
- **Auditora:** puede consultar payloads, respuestas e historial, pero no puede
  alterar la ejecución.

Corregir una conexión no borra el `401` ni cuenta como un intento del pedido:
agrega una actividad de auditoría y habilita un intento nuevo. Cerrar un caso
tampoco finge una entrega exitosa: lo marca como **Cerrado sin entregar**,
conserva su único intento y bloquea futuros reenvíos.

Para enseñar el comportamiento sin depender de sistemas externos, **Simular
entradas** permite provocar un pedido para envío, una solicitud de factura o una
ráfaga de dos envíos y una factura. En producción ese botón no sería necesario:
los avisos llegarían solos y el tablero simplemente mostraría todas las
ejecuciones activas.

El cierre incluye motivos frecuentes y **Otro motivo**. Cuando se selecciona
este último, la historia escrita es obligatoria y queda visible en el resumen y
en la actividad de auditoría.

## Qué ocurre por dentro

1. El webhook identifica el flujo activo mediante un token que no se guarda en
   texto plano.
2. DynamoDB registra en una sola transacción la clave de deduplicación, la
   ejecución y el mensaje de outbox.
3. DynamoDB Streams despierta al dispatcher y éste publica la entrega en SQS
   FIFO.
4. El worker reclama la ejecución de forma condicional; otro worker no puede
   procesarla al mismo tiempo.
5. El destino ficticio responde `503` en el primer intento. La ejecución queda
   en `FAILED_RETRYABLE` y el intento permanece en el historial.
6. La operadora pulsa **Reintentar entrega**. Se publica un nuevo mensaje con un
   identificador de entrega distinto, pero se conserva el mismo evento y el
   mismo correlation ID.
7. El destino responde `202`. La ejecución termina en `SUCCEEDED` y ambos
   intentos quedan visibles.

## Prueba manual esperada

| Paso | Acción | Resultado esperado |
| --- | --- | --- |
| 1 | Enviar `evt_order_1042` | HTTP `202`, ejecución `QUEUED` |
| 2 | Esperar la primera entrega | Ejecución `FAILED_RETRYABLE`, intento 1 = `503` |
| 3 | Abrir el detalle | Payload, correlation ID y respuesta `503` visibles |
| 4 | Pulsar **Reintentar entrega** | Nuevo mensaje en cola; no se crea otra ejecución |
| 5 | Esperar el worker | Ejecución `SUCCEEDED`, intento 2 = `202` |
| 6 | Reenviar `evt_order_1042` | Resultado `DUPLICATE`; no hay tercera entrega |

## La carnita para explicar en portafolio

El proyecto no es sólo un formulario que llama una API. Resuelve tres problemas
reales de integraciones empresariales:

- **No perder eventos:** el outbox se guarda junto con la ejecución antes de
  depender de la cola.
- **No duplicar operaciones:** DynamoDB rechaza de forma atómica el mismo evento
  para la misma organización y flujo.
- **Poder operar fallos:** cada intento es auditable y sólo los errores
  temporales admiten reintento manual.

La interfaz demuestra esas decisiones: no oculta el fallo, enseña su ruta, su
respuesta y la transición completa del reintento exitoso.
