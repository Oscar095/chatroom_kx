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
