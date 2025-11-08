const { Sequelize, DataTypes } = require("sequelize");
const path = require("path");
const fs = require("fs");

// Koneksi ke SQLite
const dbPath = path.join(__dirname, "../database.sqlite");
const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: dbPath,
  logging: false,
});

// Cek dan tambahkan kolom jika belum ada
async function ensureColumnExists() {
  // Kolom penjadwalan_aktif di tabel perangkat
  const perangkatTable = "perangkat";
  const perangkatColumn = "penjadwalan_aktif";

  const [perangkatResults] = await sequelize.query(
    `PRAGMA table_info(${perangkatTable})`
  );
  const perangkatColumnExists = perangkatResults.some(
    (col) => col.name === perangkatColumn
  );

  if (!perangkatColumnExists) {
    await sequelize.query(
      `ALTER TABLE ${perangkatTable} ADD COLUMN ${perangkatColumn} BOOLEAN DEFAULT 0`
    );
    console.log(
      `✅ Kolom '${perangkatColumn}' ditambahkan ke tabel '${perangkatTable}'`
    );
  }

  // Kolom aktif di tabel penjadwalan
  const penjadwalanTable = "penjadwalan";
  const penjadwalanColumn = "aktif";

  const [penjadwalanResults] = await sequelize.query(
    `PRAGMA table_info(${penjadwalanTable})`
  );
  const penjadwalanColumnExists = penjadwalanResults.some(
    (col) => col.name === penjadwalanColumn
  );

  if (!penjadwalanColumnExists) {
    await sequelize.query(
      `ALTER TABLE ${penjadwalanTable} ADD COLUMN ${penjadwalanColumn} BOOLEAN NOT NULL DEFAULT 1`
    );
    console.log(
      `✅ Kolom '${penjadwalanColumn}' ditambahkan ke tabel '${penjadwalanTable}'`
    );
  }
}

// Model Perangkat
const Perangkat = sequelize.define(
  "Perangkat",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    nama_perangkat: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // tambahkan unique constraint
    },
    topik_mqtt: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    topik_kontrol: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    daya_watt: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    durasi_jam: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    tipe: {
      type: DataTypes.ENUM("Non Interrupt", "Interrupt", "Tidak Ada"),
      defaultValue: "Tidak Ada",
    },
    status: {
      type: DataTypes.STRING,
    },
    penjadwalan_aktif: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    skor_prioritas: {
      type: DataTypes.DECIMAL(10, 4),
      allowNull: false,
      defaultValue: 0,
    },
    kuota_durasi: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    durasi_terpakai: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "perangkat",
    timestamps: false,
  }
);

// Model Data Penggunaan
const DataPenggunaan = sequelize.define(
  "DataPenggunaan",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    perangkat_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "perangkat", key: "id" },
      onDelete: "CASCADE",
    },
    volt: DataTypes.FLOAT,
    ampere: DataTypes.FLOAT,
    watt: DataTypes.FLOAT,
    energy: DataTypes.FLOAT,
    energy_delta: DataTypes.FLOAT,
    timestamp: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  {
    tableName: "data_penggunaan",
    timestamps: false,
  }
);

// Model Limit Energi
const LimitEnergi = sequelize.define(
  "LimitEnergi",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    tanggal_mulai: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    tanggal_selesai: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    batas_kwh: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
  },
  {
    tableName: "limit",
    timestamps: false,
  }
);

// ✅ Model Penjadwalan
const Penjadwalan = sequelize.define(
  "Penjadwalan",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    perangkat_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "perangkat", key: "id" },
      onDelete: "CASCADE",
    },
    tanggal_mulai: { type: DataTypes.DATEONLY, allowNull: false },
    tanggal_selesai: { type: DataTypes.DATEONLY, allowNull: false },
    jam_mulai: { type: DataTypes.TIME, allowNull: false },
    jam_selesai: { type: DataTypes.TIME, allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: "OFF" },
    aktif: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "penjadwalan",
    timestamps: false,
  }
);

//Model AktivasiManual
const AktivasiManual = sequelize.define(
  "AktivasiManual",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    perangkat_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: "perangkat", key: "id" },
      onDelete: "CASCADE",
    },
    tanggal_mulai: { type: DataTypes.DATEONLY, allowNull: false },
    tanggal_selesai: { type: DataTypes.DATEONLY, allowNull: true },
    jam_mulai: { type: DataTypes.TIME, allowNull: false },
    jam_selesai: { type: DataTypes.TIME, allowNull: true },
    durasi_menit: { type: DataTypes.INTEGER, allowNull: true },
    tipe: { type: DataTypes.STRING, allowNull: false, defaultValue: "Manual" },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "aktivasi_manual",
    timestamps: false,
  }
);

// Model Kapasitas Daya
const KapasitasDaya = sequelize.define(
  "KapasitasDaya",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    kapasitas_daya: {
      type: DataTypes.FLOAT, // nilai daya dalam Watt/VA
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    },
  },
  {
    tableName: "kapasitas_daya",
    timestamps: false,
  }
);

// Relasi
Perangkat.hasMany(DataPenggunaan, { foreignKey: "perangkat_id" });
DataPenggunaan.belongsTo(Perangkat, { foreignKey: "perangkat_id" });

Perangkat.hasMany(Penjadwalan, { foreignKey: "perangkat_id" });
Penjadwalan.belongsTo(Perangkat, { foreignKey: "perangkat_id" });

Perangkat.hasMany(AktivasiManual, { foreignKey: "perangkat_id" });
AktivasiManual.belongsTo(Perangkat, { foreignKey: "perangkat_id" });

// Sync DB
(async () => {
  try {
    await sequelize.sync({ force: false });
    await ensureColumnExists();
    console.log("✅ Model berhasil disinkronisasi");
  } catch (err) {
    console.error("❌ Gagal sinkronisasi DB:", err.message);
    console.log(
      "💡 Jika tabel sudah ada dan struktur berbeda, gunakan script reset-database.js"
    );
  }
})();

module.exports = {
  sequelize,
  Perangkat,
  DataPenggunaan,
  LimitEnergi,
  Penjadwalan,
  AktivasiManual,
  KapasitasDaya,
};
