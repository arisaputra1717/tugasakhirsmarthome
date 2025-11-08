const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Konfigurasi MQTT - Menggunakan broker EMQX public
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const client = mqtt.connect(MQTT_BROKER);

// Konfigurasi SQLite
const dbPath = path.join(__dirname, 'energy_data.db');
const db = new sqlite3.Database(dbPath);

// Inisialisasi database
function initDatabase(callback) {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS energy_data (
            id TEXT PRIMARY KEY,
            energi_total REAL DEFAULT 0,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error('❌ Error creating table:', err);
                return;
            }
            console.log('✅ Database table created/verified');
            
            // Insert data awal jika belum ada
            const perangkatIds = ['kulkas', 'laptop', 'lampu', 'pompa'];
            let completed = 0;
            
            perangkatIds.forEach(id => {
                db.run(`INSERT OR IGNORE INTO energy_data (id, energi_total) VALUES (?, 0)`, [id], (err) => {
                    if (err) {
                        console.error(`❌ Error inserting ${id}:`, err);
                    }
                    completed++;
                    if (completed === perangkatIds.length) {
                        console.log('✅ Initial data inserted');
                        if (callback) callback();
                    }
                });
            });
        });
    });
}

// Fungsi untuk load energy data dari database
function loadEnergyData(callback) {
    db.all(`SELECT id, energi_total FROM energy_data`, [], (err, rows) => {
        if (err) {
            console.error('❌ Error loading energy data:', err);
            callback();
            return;
        }
        
        rows.forEach(row => {
            const perangkat = perangkatList.find(p => p.id === row.id);
            if (perangkat) {
                perangkat.energi_total = row.energi_total;
                console.log(`📂 [${perangkat.id}] Loaded energy: ${row.energi_total} kWh`);
            }
        });
        callback();
    });
}

// Fungsi untuk save energy data ke database
function saveEnergyData(perangkat) {
    db.run(`UPDATE energy_data SET energi_total = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`, 
        [perangkat.energi_total, perangkat.id], 
        (err) => {
            if (err) {
                console.error(`❌ Error saving energy data for ${perangkat.id}:`, err);
            }
        }
    );
}

// Data perangkat dengan konsumsi daya yang lebih realistis
const perangkatList = [
    {
        id: 'kulkas',
        topic_data: 'smart-energy/perangkat/kulkas/data',
        topic_kontrol: 'smart-energy/perangkat/kulkas/kontrol',
        status: 'ON',
        energi_total: 0,
        watt_range: [150, 250], // Kulkas: 150-250W
        multiplier: 1.5 // Multiplier untuk mempercepat konsumsi
    },
    {
        id: 'laptop',
        topic_data: 'smart-energy/perangkat/laptop/data',
        topic_kontrol: 'smart-energy/perangkat/laptop/kontrol',
        status: 'ON',
        energi_total: 0,
        watt_range: [45, 90], // Laptop: 45-90W
        multiplier: 2.0 // Multiplier untuk mempercepat konsumsi
    },
    {
        id: 'lampu',
        topic_data: 'smart-energy/perangkat/lampu/data',
        topic_kontrol: 'smart-energy/perangkat/lampu/kontrol',
        status: 'ON',
        energi_total: 0,
        watt_range: [15, 25], // Lampu LED: 15-25W
        multiplier: 3.0 // Multiplier untuk mempercepat konsumsi
    },
    {
        id: 'pompa',
        topic_data: 'smart-energy/perangkat/pompa/data',
        topic_kontrol: 'smart-energy/perangkat/pompa/kontrol',
        status: 'ON',
        energi_total: 0,
        watt_range: [370, 750], // Pompa air: 370-750W
        multiplier: 1.2 // Multiplier untuk mempercepat konsumsi
    }
];

// Fungsi untuk generate data sensor dengan konsumsi yang lebih realistis
function generateRandomSensorData(perangkat) {
    // Generate watt berdasarkan range perangkat
    const minWatt = perangkat.watt_range[0];
    const maxWatt = perangkat.watt_range[1];
    const watt = Math.round((minWatt + Math.random() * (maxWatt - minWatt)) * 10) / 10;
    
    // Hitung volt dan ampere berdasarkan watt
    const volt = Math.round((220 + Math.random() * 20) * 10) / 10; // 220-240V
    const ampere = Math.round((watt / volt) * 100) / 100;
    
    // Energy bertahap dengan multiplier untuk mempercepat
    if (perangkat.status === 'ON') {
        // Increment energi berdasarkan konsumsi watt (kWh)
        // Interval 5 detik dengan multiplier untuk mempercepat
        const baseIncrement = watt * (5 / 3600) / 1000; // Base increment
        const increment = baseIncrement * perangkat.multiplier; // Dengan multiplier
        perangkat.energi_total += increment;
        
        // Save ke database setiap update
        saveEnergyData(perangkat);
    }
    
    return {
        volt: volt,
        ampere: ampere,
        watt: watt,
        energy: Math.round(perangkat.energi_total * 1000) / 1000 // 3 decimal places
    };
}

// Fungsi untuk publish data sensor
function publishSensorData(perangkat) {
    const data = generateRandomSensorData(perangkat);
    
    const payload = {
        volt: data.volt,
        ampere: data.ampere,
        watt: data.watt,
        energy: data.energy
    };
    
    client.publish(perangkat.topic_data, JSON.stringify(payload));
    console.log(`📊 [${perangkat.id}] Data sent:`, payload);
}

// Fungsi untuk subscribe ke topic kontrol
function subscribeToControlTopics() {
    perangkatList.forEach(perangkat => {
        client.subscribe(perangkat.topic_kontrol, (err) => {
            if (err) {
                console.error(`❌ Error subscribing to ${perangkat.topic_kontrol}:`, err);
            } else {
                console.log(`✅ Subscribed to ${perangkat.topic_kontrol}`);
            }
        });
    });
}

// Fungsi untuk handle pesan kontrol
function handleControlMessage(topic, message) {
    try {
        const data = JSON.parse(message.toString());
        const perangkat = perangkatList.find(p => p.topic_kontrol === topic);
        
        if (perangkat && (data.status === 'ON' || data.status === 'OFF')) {
            const oldStatus = perangkat.status;
            perangkat.status = data.status;
            
            console.log(`🔄 [${perangkat.id}] Status changed: ${oldStatus} → ${perangkat.status}`);
            
            // Kirim konfirmasi status
            const confirmPayload = {
                perangkat_id: perangkat.id,
                status: perangkat.status,
                timestamp: new Date().toISOString(),
                success: true
            };
            
            client.publish(`${perangkat.topic_kontrol}/response`, JSON.stringify(confirmPayload));
            
            // Kirim data sensor terbaru setelah perubahan status
            setTimeout(() => {
                publishSensorData(perangkat);
            }, 1000);
        }
    } catch (error) {
        console.error('❌ Error parsing control message:', error);
    }
}

// Event handlers
client.on('connect', () => {
    console.log('🚀 MQTT Simulator connected to broker.emqx.io');
    console.log('📡 Starting device simulation with FASTER energy consumption...\n');
    console.log('⚡ Energy consumption multipliers:');
    perangkatList.forEach(perangkat => {
        console.log(`   - ${perangkat.id}: ${perangkat.watt_range[0]}-${perangkat.watt_range[1]}W (${perangkat.multiplier}x faster)`);
    });
    console.log('');
    
    // Inisialisasi database dulu, baru load data
    initDatabase(() => {
        loadEnergyData(() => {
            subscribeToControlTopics();
            
            // Kirim data awal untuk semua perangkat
            perangkatList.forEach(perangkat => {
                publishSensorData(perangkat);
            });
            
            // Set interval untuk mengirim data secara berkala (lebih sering)
            setInterval(() => {
                perangkatList.forEach(perangkat => {
                    publishSensorData(perangkat);
                });
                console.log('─────────────────────────────────────');
            }, 300); // Kirim data setiap 3 detik (lebih sering)
        });
    });
});

client.on('message', (topic, message) => {
    console.log(`📨 Received control message on ${topic}:`, message.toString());
    handleControlMessage(topic, message);
});

client.on('error', (error) => {
    console.error('❌ MQTT connection error:', error);
});

client.on('close', () => {
    console.log('📡 MQTT connection closed');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down simulator...');
    db.close((err) => {
        if (err) {
            console.error('❌ Error closing database:', err);
        } else {
            console.log('💾 Database closed successfully');
        }
        client.end();
        process.exit(0);
    });
});

// Inisialisasi database saat startup
initDatabase();

// Fungsi untuk simulasi acak ON/OFF (opsional)
function simulateRandomActivity() {
    setInterval(() => {
        const randomDevice = perangkatList[Math.floor(Math.random() * perangkatList.length)];
        const randomStatus = Math.random() > 0.5 ? 'ON' : 'OFF';
        
        if (randomDevice.status !== randomStatus) {
            randomDevice.status = randomStatus;
            console.log(`🎲 [Random] ${randomDevice.id} turned ${randomStatus}`);
            publishSensorData(randomDevice);
        }
    }, 30000); // Simulasi acak setiap 30 detik
}

// Aktifkan simulasi acak (uncomment jika diperlukan)
// setTimeout(simulateRandomActivity, 10000);

console.log('🔧 MQTT Device Simulator Starting...');
console.log('📋 Devices to simulate:');
perangkatList.forEach(perangkat => {
    console.log(`   - ${perangkat.id}`);
});
console.log('');