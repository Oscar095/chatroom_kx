-- Directorio de transportadoras del panel ChatRoom.
--
-- Vive en el esquema `kx` por la misma razon que kx.pedidos: kos_apps es una
-- base compartida y `dbo.*` / `planeacion.*` son del MES.
--
-- A diferencia de kx.pedidos, aqui NO hay ninguna API detras: la tabla la
-- llena el asesor a mano desde el panel. No hay sincronizacion que pueda
-- pisar estos datos, asi que todas las columnas son suyas.
--
-- Se ejecuta solo:  node sql/migrar-transportadoras.js

IF SCHEMA_ID('kx') IS NULL
    EXEC('CREATE SCHEMA kx');
GO

IF OBJECT_ID('kx.transportadoras', 'U') IS NULL
BEGIN
    CREATE TABLE kx.transportadoras (
        -- La llave es un IDENTITY y no el nombre: corregirle una tilde a
        -- "Envia" no puede obligar a borrar la fila y volverla a crear.
        id              INT             IDENTITY(1,1) NOT NULL,

        nombre          NVARCHAR(120)   NOT NULL,

        -- URL de la pagina de rastreo. Se guarda TAL CUAL la escribio el
        -- asesor, con su marcador {guia} si lo lleva: es el mismo convenio de
        -- TCC_RASTREO_URL en el .env, que server.js sustituye en urlRastreo().
        -- Por eso no se normaliza con new URL(): eso convertiria {guia} en
        -- %7Bguia%7D y la sustitucion dejaria de encontrarlo.
        url_rastreo     NVARCHAR(500)   NOT NULL,

        creado_en       DATETIME2(3)    NOT NULL CONSTRAINT DF_kx_transportadoras_creado DEFAULT (SYSDATETIME()),
        actualizado_en  DATETIME2(3)    NOT NULL CONSTRAINT DF_kx_transportadoras_actualizado DEFAULT (SYSDATETIME()),

        CONSTRAINT PK_kx_transportadoras PRIMARY KEY (id)
    );

    -- Dos "TCC" en la lista no son dos transportadoras: son un error de
    -- digitacion que deja al asesor sin saber cual de las dos URL vale.
    CREATE UNIQUE INDEX UX_kx_transportadoras_nombre
        ON kx.transportadoras (nombre);
END
GO
