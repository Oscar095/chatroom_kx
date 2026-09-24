-- Tabla de pedidos pendientes del panel ChatRoom.
--
-- Vive en su propio esquema `kx` y no en `dbo` porque kos_apps es una base
-- compartida: `dbo.*` y `planeacion.*` son del MES y no tienen nada que ver
-- con esto.
--
-- Las columnas f430_* y "Nombre Cliente" las manda la API de Siesa. `no_guia`
-- y `despachado` NO existen en Siesa: las escribe el asesor desde el panel, y
-- por eso la sincronizacion tiene prohibido tocarlas (ver el MERGE en
-- server.js). Si alguna vez se sobreescriben, el asesor pierde su trabajo.
--
-- Se ejecuta solo:  node sql/migrar-pedidos.js

IF SCHEMA_ID('kx') IS NULL
    EXEC('CREATE SCHEMA kx');
GO

IF OBJECT_ID('kx.pedidos', 'U') IS NULL
BEGIN
    CREATE TABLE kx.pedidos (
        -- Llave natural del documento en Siesa. Viene como 'PK ' con espacio
        -- al final; se guarda ya recortada.
        id_tipo_docto   VARCHAR(10)     NOT NULL,
        consec_docto    INT             NOT NULL,

        -- Columnas que llegan de la API
        fecha_registro  DATETIME2(3)    NULL,      -- f430_ts
        nombre_cliente  NVARCHAR(200)   NULL,      -- "Nombre Cliente"
        fecha_entrega   DATETIME2(3)    NULL,      -- "Fecha Entrega"

        -- Columnas propias del panel
        no_guia         NVARCHAR(100)   NULL,
        despachado      BIT             NOT NULL CONSTRAINT DF_kx_pedidos_despachado DEFAULT (0),
        despachado_en   DATETIME2(3)    NULL,

        -- `pendiente` en 0 = el pedido ya no viene en la API. No se borra la
        -- fila: se perderian la guia y la marca de despacho del asesor.
        pendiente       BIT             NOT NULL CONSTRAINT DF_kx_pedidos_pendiente DEFAULT (1),

        creado_en       DATETIME2(3)    NOT NULL CONSTRAINT DF_kx_pedidos_creado DEFAULT (SYSDATETIME()),
        actualizado_en  DATETIME2(3)    NOT NULL CONSTRAINT DF_kx_pedidos_actualizado DEFAULT (SYSDATETIME()),
        sincronizado_en DATETIME2(3)    NULL,

        CONSTRAINT PK_kx_pedidos PRIMARY KEY (id_tipo_docto, consec_docto)
    );

    CREATE INDEX IX_kx_pedidos_pendientes
        ON kx.pedidos (pendiente, despachado)
        INCLUDE (fecha_entrega, nombre_cliente);
END
GO

-- Columnas agregadas despues de la primera version. Van como ALTER aparte para
-- que el archivo sirva igual en una base nueva y en una que ya tiene la tabla.
--
-- `contacto` es el celular al que se le avisa que el pedido salio. Es del
-- asesor, igual que `no_guia` y `despachado`: la sincronizacion NO lo toca.
-- Se guarda normalizado a 57XXXXXXXXXX, el mismo formato que usa `sessionId`
-- en wa_chats, para que un dia se puedan cruzar pedido y conversacion.
IF COL_LENGTH('kx.pedidos', 'contacto') IS NULL
    ALTER TABLE kx.pedidos ADD contacto NVARCHAR(20) NULL;
GO

-- Sello del aviso enviado. Existe para no volver a cobrarle a KOS una plantilla
-- ya mandada y, sobre todo, para no repetirle el mensaje al cliente.
IF COL_LENGTH('kx.pedidos', 'notificado_en') IS NULL
    ALTER TABLE kx.pedidos ADD notificado_en DATETIME2(3) NULL;
GO

-- El id que devuelve Meta. Es lo unico con lo que se puede rastrear el envio
-- en el log de n8n o en el Administrador de WhatsApp si el cliente reclama.
IF COL_LENGTH('kx.pedidos', 'notificacion_wamid') IS NULL
    ALTER TABLE kx.pedidos ADD notificacion_wamid NVARCHAR(120) NULL;
GO

-- Etapas de produccion. El pedido pasa por impresion, formacion y bodega antes
-- de despacharse, y el asesor va marcando cada una desde el panel. Son columnas
-- del asesor igual que `no_guia` y `despachado`: la sincronizacion NO las toca.
--
-- Cada etapa lleva su propio sello de fecha, como `despachado_en`: saber CUANDO
-- avanzo un pedido es lo que permite ver donde se quedo trabado. El sello se
-- limpia si el asesor desmarca la casilla, para que no quede una fecha
-- contando una etapa que ya no esta marcada.
--
-- No hay orden obligatorio entre ellas: un pedido puede entrar directo a bodega
-- sin pasar por impresion, y forzar la secuencia solo dejaria al asesor sin
-- poder registrar lo que realmente paso.
IF COL_LENGTH('kx.pedidos', 'impresion') IS NULL
    ALTER TABLE kx.pedidos ADD impresion BIT NOT NULL CONSTRAINT DF_kx_pedidos_impresion DEFAULT (0);
GO

IF COL_LENGTH('kx.pedidos', 'impresion_en') IS NULL
    ALTER TABLE kx.pedidos ADD impresion_en DATETIME2(3) NULL;
GO

IF COL_LENGTH('kx.pedidos', 'formacion') IS NULL
    ALTER TABLE kx.pedidos ADD formacion BIT NOT NULL CONSTRAINT DF_kx_pedidos_formacion DEFAULT (0);
GO

IF COL_LENGTH('kx.pedidos', 'formacion_en') IS NULL
    ALTER TABLE kx.pedidos ADD formacion_en DATETIME2(3) NULL;
GO

IF COL_LENGTH('kx.pedidos', 'bodega') IS NULL
    ALTER TABLE kx.pedidos ADD bodega BIT NOT NULL CONSTRAINT DF_kx_pedidos_bodega DEFAULT (0);
GO

IF COL_LENGTH('kx.pedidos', 'bodega_en') IS NULL
    ALTER TABLE kx.pedidos ADD bodega_en DATETIME2(3) NULL;
GO

-- Quien hizo el ultimo cambio desde el panel. Es la columna que acompaña a
-- `actualizado_en`: esa dice CUANDO se toco la fila y esta dice QUIEN.
--
-- Guarda el usuario del panel (`dianan`, `oscaro`…), no un nombre bonito: es la
-- identidad con la que se inicia sesion y la misma que queda en la coleccion
-- `auditoria` de Mongo, para poder cruzar las dos sin adivinar.
--
-- Es del asesor, como `no_guia` y las cuatro etapas: la sincronizacion con
-- Siesa NO la toca. Si el MERGE la pisara, cada sincronizacion borraria el
-- rastro de quien digito la guia — que es justo lo que esta columna existe
-- para no perder.
--
-- Admite NULL a proposito: las filas anteriores al login no tienen a quien
-- atribuirles nada, y ponerles un usuario inventado seria peor que dejarlas
-- vacias.
IF COL_LENGTH('kx.pedidos', 'usuario') IS NULL
    ALTER TABLE kx.pedidos ADD usuario NVARCHAR(60) NULL;
GO

-- Quinta etapa: el cliente ya recibio el pedido. Se guarda igual que las
-- demas (bandera + sello) y es la que habilita la encuesta de satisfaccion.
IF COL_LENGTH('kx.pedidos', 'recibido') IS NULL
    ALTER TABLE kx.pedidos ADD recibido BIT NOT NULL CONSTRAINT DF_kx_pedidos_recibido DEFAULT (0);
GO

IF COL_LENGTH('kx.pedidos', 'recibido_en') IS NULL
    ALTER TABLE kx.pedidos ADD recibido_en DATETIME2(3) NULL;
GO

-- Encuesta de satisfaccion: se envia cuando el pedido esta marcado como
-- recibido. Va separada de notificado_en/notificacion_wamid porque esas dos
-- son del aviso de despacho, un envio distinto con su propia plantilla.
IF COL_LENGTH('kx.pedidos', 'encuesta_enviada_en') IS NULL
    ALTER TABLE kx.pedidos ADD encuesta_enviada_en DATETIME2(3) NULL;
GO

IF COL_LENGTH('kx.pedidos', 'encuesta_wamid') IS NULL
    ALTER TABLE kx.pedidos ADD encuesta_wamid NVARCHAR(120) NULL;
GO
