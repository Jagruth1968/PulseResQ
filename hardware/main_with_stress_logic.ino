/*
  main_with_stress_logic.ino
  PulseResQ - fork with rule-based stress handling and calm-down haptics
  - Sensor-agnostic placeholders for ECG and SpO2
  - Motion suppression (MPU6050 optional)
  - Calm-down vibration for IHD patients
  - Emergency triggers reuse existing MQTT + Firebase sends
  - Keep original WiFi / MQTT / Firebase behaviour active
*/

/* ---------- INCLUDES ----------
   Keep existing libraries; add notes where sensor-specific libs belong.
*/
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <HTTPClient.h>
#include <TinyGPSPlus.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
// MAX30105 library may vary per hardware; keep placeholder include commented.
// #include "MAX30105.h"

// ---------- CONFIG ----------
const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASS";

const char* MQTT_SERVER = "your.mqtt.broker";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "";
const char* MQTT_PASSWD = "";
const char* MQTT_TOPIC_DATA = "PulseResQ/data";
const char* MQTT_TOPIC_ALERT = "PulseResQ/alerts";

const char* FIREBASE_URL = "https://your-project.firebaseio.com/pulseresq.json"; // must be https

// ---------- PINS ----------
const int PIN_ECG = 34;       // AD8232 analog output (ADC1_CH6) - chest patch
const int PIN_BUZZER = 27;    // emergency buzzer (also used as loud alert)
const int PIN_LED = 2;        // status LED
const int PIN_VIB = 26;       // gentle vibration motor pin for calm-down alert (change if needed)

// I2C
#define I2C_SDA 21
#define I2C_SCL 22

// GPS Serial2 pins
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
#define GPS_BAUD   9600

// ---------- HARDWARE OBJECTS ----------
WiFiClient espClient;
PubSubClient mqttClient(espClient);
HTTPClient http;

TinyGPSPlus gps;
HardwareSerial SerialGPS(2);

Adafruit_MPU6050 mpu;
// MAX30105 particleSensor; // use when you pick the exact library

// ---------- STATE + THRESHOLDS (rule-based, no score) ----------
bool IS_IHD_PATIENT = true; // set per patient profile (flip to false for others)

unsigned long lastMQTTPublish = 0;
const unsigned long PUBLISH_INTERVAL = 5000; // 5s

// thresholds - tune per patient
const float BPM_STRESS_MIN = 100.0;     // elevated but non-critical
const float BPM_STRESS_MAX = 120.0;
const float BPM_ALERT_CRITICAL = 140.0; // critical BPM -> emergency when resting

const float SPO2_STRESS_MIN = 90.0;
const float SPO2_CRITICAL = 88.0;

const int BP_SYS_STRESS = 140;          // optional: retrieved from watch
const int BP_SYS_CRITICAL = 180;

const unsigned long CALM_DETECT_DURATION = 15000; // 15s sustained while resting
const unsigned long CALM_COOLDOWN = 10UL * 60UL * 1000UL; // 10 min
const unsigned long EMERGENCY_COOLDOWN = 60UL * 1000UL; // 60s

// sensor readings
float measuredECG_BPM = 0.0;
float measuredSPO2 = 0.0;
float measuredPulseFromSpO2 = 0.0;
float accelX=0, accelY=0, accelZ=0;
double gpsLat = 0.0, gpsLng = 0.0;
String gpsTimeIso = "";

int latestBPsys = -1; // updated via BLE placeholder when watch is integrated
bool lowHRVFlag = false; // optional: implement HRV detection to set this

// ---------- internal stress timers ----------
unsigned long _lastCalmSent = 0;
unsigned long _lastEmergencySent = 0;
unsigned long _calmStart = 0;
unsigned long _emergStart = 0;

// ---------- forward declarations ----------
void connectWiFi();
void ensureMqttConnected();
void startSensors();
void readGPS();
void readMPU6050();
void readMAX3010x(); // placeholder
float computeBPMFromECG(); // placeholder ECG reader
void publishTelemetry();
void triggerEmergency(const char* reason);
void clearEmergency();
void calmDownAction();
void emergencyAction();
bool isMoving(); // motion detection wrapper
void stressLogic_init();
enum StressState { ST_NORMAL = 0, ST_CALM_DOWN_SUGGEST, ST_ESCALATE_EMERGENCY };
StressState stressLogic_update(bool moving, int bp_sys = -1, bool lowHRVFlag = false);

// ---------- Wi-Fi / MQTT ----------
void connectWiFi() {
  Serial.print("WiFi connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(400);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi not connected (timeout).");
  }
}

void ensureMqttConnected() {
  static unsigned long lastTry = 0;
  const unsigned long TRY_INTERVAL = 2000;
  if (mqttClient.connected()) return;
  if (millis() - lastTry < TRY_INTERVAL) return;
  lastTry = millis();
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  Serial.print("MQTT connect...");
  String clientId = "ESP32-PulseResQ-" + String((uint32_t)esp_random(), HEX);
  if (mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWD)) {
    Serial.println("MQTT connected");
    mqttClient.subscribe(MQTT_TOPIC_ALERT);
  } else {
    Serial.print("failed, rc=");
    Serial.println(mqttClient.state());
  }
}

// ---------- Sensors startup ----------
void startSensors() {
  // MPU6050
  if (!mpu.begin()) {
    Serial.println("MPU6050 not found! motion detection will be disabled.");
  } else {
    Serial.println("MPU6050 started");
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  }

  // MAX30105 / SpO2 placeholder: actual init depends on chosen library
  Serial.println("Note: MAX3010x initialization is placeholder — replace with your chosen lib.");

  // ADC setup for ECG pin
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_ECG, ADC_11db);
}

// ---------- Minimal placeholder ECG BPM computation ----------
float computeBPMFromECG() {
  // Placeholder: simple threshold crossing over 6s window was in original.
  // Here we sample and use a very simple moving average + threshold dynamic baseline.
  static unsigned long windowStart = 0;
  static int peaks = 0;
  static bool above = false;
  static int baseline = 2000;

  int raw = analogRead(PIN_ECG); // 0..4095
  baseline = (baseline * 63 + raw) >> 6; // slow IIR baseline

  unsigned long now = millis();
  if (windowStart == 0) windowStart = now;

  int dynamicThresh = baseline + 250;

  if (!above && raw > dynamicThresh && now - windowStart > 250) {
    peaks++;
    above = true;
  } else if (above && raw < baseline + 120) {
    above = false;
  }

  if (now - windowStart >= 6000) { // 6-second window
    float bpm = (peaks / 6.0) * 60.0;
    windowStart = now;
    peaks = 0;
    return bpm;
  }
  return -1; // not ready
}

// ---------- Placeholder SpO2 reader ----------
void readSpO2_placeholder() {
  // Replace this with actual MAX3010x or MAX30102 code.
  // For now simulate or leave previous measuredSPO2 unchanged.
  // measuredSPO2 = ...;
  // measuredPulseFromSpO2 = ...;
}

// ---------- MAX3010x read placeholder ----------
void readMAX3010x() {
  readSpO2_placeholder();
}

// ---------- MPU6050 read ----------
void readMPU6050() {
  if (!mpu.begin()) {
    // if not present, keep previous values or set to zero
    return;
  }
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  accelX = a.acceleration.x;
  accelY = a.acceleration.y;
  accelZ = a.acceleration.z;
}

// ---------- GPS read ----------
void readGPS() {
  while (SerialGPS.available()) {
    gps.encode(SerialGPS.read());
  }
  if (gps.location.isUpdated()) {
    gpsLat = gps.location.lat();
    gpsLng = gps.location.lng();
    if (gps.date.isValid() && gps.time.isValid()) {
      char buf[64];
      snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02uZ",
               gps.date.year(), gps.date.month(), gps.date.day(),
               gps.time.hour(), gps.time.minute(), gps.time.second());
      gpsTimeIso = String(buf);
    }
  }
}

// ---------- Movement detection ----------
bool isMoving() {
  // If MPU present, use magnitude variance / threshold
  // If MPU not present, conservatively return false (assume resting)
  // Note: if you want the opposite, change default.
  // Use a moving average of g to suppress noise.
  static bool mpuAvailableChecked = false;
  static bool mpuAvailable = false;
  if (!mpuAvailableChecked) {
    mpuAvailableChecked = true;
    // Try a quick call to detect presence
    if (mpu.begin()) {
      mpuAvailable = true;
    } else {
      mpuAvailable = false;
    }
  }
  if (!mpuAvailable) {
    // No MPU: fall back to "not moving" (conservative for alerts) OR
    // You could choose to return true to suppress alerts during unknown motion.
    return false;
  }
  // Read fresh accel
  readMPU6050();
  // accel in m/s^2; convert to g:
  float g = sqrt(accelX*accelX + accelY*accelY + accelZ*accelZ) / 9.80665;
  // Motion threshold: if magnitude deviates > 0.12g from 1g (standing)
  static float gAvg = 1.0;
  gAvg = (gAvg * 63.0 + g) / 64.0; // slow IIR
  float diff = fabs(g - gAvg);
  const float MOTION_THRESHOLD = 0.12; // tune this
  return diff > MOTION_THRESHOLD;
}

// ---------- Telemetry publish (MQTT + Firebase) ----------
void publishTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!mqttClient.connected()) ensureMqttConnected();

  char payload[512];
  int len = snprintf(payload, sizeof(payload),
    "{\"ecg_bpm\":%.1f,\"spo2\":%.1f,\"pulse_spo2\":%.1f,\"accel\":{\"x\":%.2f,\"y\":%.2f,\"z\":%.2f},\"gps\":{\"lat\":%.6f,\"lng\":%.6f},\"time\":\"%s\"}",
    measuredECG_BPM, measuredSPO2, measuredPulseFromSpO2, accelX, accelY, accelZ, gpsLat, gpsLng, gpsTimeIso.c_str());

  if (mqttClient.connected()) mqttClient.publish(MQTT_TOPIC_DATA, payload);

  // Firebase HTTPS POST using WiFiClientSecure recommended.
  // The original sketch used HTTPClient with http.begin(FIREBASE_URL) — keep, but for https you must use WiFiClientSecure.
  http.begin(FIREBASE_URL);
  http.addHeader("Content-Type", "application/json");
  int httpCode = http.POST(String(payload));
  Serial.print("Firebase POST code: "); Serial.println(httpCode);
  http.end();
}

// ---------- Emergency handling (reuses previous trigger semantics) ----------
bool emergencyActive = false;
void triggerEmergency(const char* reason) {
  if (!emergencyActive) {
    emergencyActive = true;
    Serial.print("EMERGENCY: ");
    Serial.println(reason);
    digitalWrite(PIN_BUZZER, HIGH);
    digitalWrite(PIN_LED, HIGH);
    // MQTT alert
    if (mqttClient.connected()) {
      char p[256];
      snprintf(p, sizeof(p), "{\"alert\":\"%s\",\"lat\":%.6f,\"lng\":%.6f}", reason, gpsLat, gpsLng);
      mqttClient.publish(MQTT_TOPIC_ALERT, p);
    }
    // Simple HTTP POST to Firebase as alert
    http.begin(FIREBASE_URL);
    http.addHeader("Content-Type", "application/json");
    String post = String("{\"alert\":\"") + reason + String("\",\"lat\":") + String(gpsLat,6) + String(",\"lng\":") + String(gpsLng,6) + String(",\"time\":\"") + gpsTimeIso + String("\"}");
    int code = http.POST(post);
    Serial.print("HTTP POST code: "); Serial.println(code);
    http.end();
  }
}

void clearEmergency() {
  emergencyActive = false;
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED, LOW);
}

// ---------- Calm-down (gentle vibration + LED blink) ----------
void calmDownAction() {
  Serial.println("CALM DOWN: gentle alert for IHD patient");
  // gentle double-tap vibration
  digitalWrite(PIN_VIB, HIGH);
  delay(350);
  digitalWrite(PIN_VIB, LOW);
  delay(200);
  digitalWrite(PIN_VIB, HIGH);
  delay(250);
  digitalWrite(PIN_VIB, LOW);

  // short blue LED blink pattern (if you wire a color LED, else reuse status LED)
  digitalWrite(PIN_LED, HIGH);
  delay(200);
  digitalWrite(PIN_LED, LOW);

  // Log via MQTT as a non-emergency event
  if (mqttClient.connected()) {
    char p[256];
    snprintf(p, sizeof(p), "{\"event\":\"calm_down\",\"hr\":%.1f,\"spo2\":%.1f}", measuredECG_BPM, measuredSPO2);
    mqttClient.publish(MQTT_TOPIC_ALERT, p);
  }
}

// ---------- Emergency action (louder / cloud notify) ----------
void emergencyAction() {
  Serial.println("EMERGENCY ACTION TRIGGERED - sending alerts");
  triggerEmergency("Critical condition detected");
}

// ---------- Rule-based stress logic (no scoring) ----------
void stressLogic_init() {
  _lastCalmSent = 0;
  _lastEmergencySent = 0;
  _calmStart = 0;
  _emergStart = 0;
}

bool hrInStressBand(float hr) {
  return (hr >= BPM_STRESS_MIN && hr <= BPM_STRESS_MAX);
}
bool hrCritical(float hr) {
  return (hr >= BPM_ALERT_CRITICAL);
}
bool spo2Critical(float spo2) {
  return (spo2 > 0 && spo2 <= SPO2_CRITICAL);
}
bool spo2LowButNotCritical(float spo2) {
  return (spo2 > SPO2_CRITICAL && spo2 < SPO2_STRESS_MIN);
}

StressState stressLogic_update(bool moving, int bp_sys, bool lowHRV) {
  unsigned long now = millis();

  if (moving) {
    _calmStart = 0;
    _emergStart = 0;
    return ST_NORMAL;
  }

  bool emergencyCond = false;
  if (hrCritical(measuredECG_BPM)) emergencyCond = true;
  if (spo2Critical(measuredSPO2)) emergencyCond = true;
  if (bp_sys > 0 && bp_sys >= BP_SYS_CRITICAL) emergencyCond = true;

  if (emergencyCond) {
    if (_emergStart == 0) _emergStart = now;
    if (now - _emergStart >= 3000) { // persistence guard
      if (now - _lastEmergencySent > EMERGENCY_COOLDOWN) {
        _lastEmergencySent = now;
        emergencyAction();
      }
      _calmStart = 0;
      return ST_ESCALATE_EMERGENCY;
    } else {
      return ST_NORMAL;
    }
  } else {
    _emergStart = 0;
  }

  bool calmCandidate = false;
  if (hrInStressBand(measuredECG_BPM)) calmCandidate = true;
  if (spo2LowButNotCritical(measuredSPO2)) calmCandidate = true;
  if (bp_sys > 0 && bp_sys >= BP_SYS_STRESS && bp_sys < BP_SYS_CRITICAL) calmCandidate = true;
  if (lowHRV) calmCandidate = true;

  if (calmCandidate && IS_IHD_PATIENT) {
    if (_calmStart == 0) _calmStart = now;
    if (now - _calmStart >= CALM_DETECT_DURATION) {
      if (now - _lastCalmSent > CALM_COOLDOWN) {
        _lastCalmSent = now;
        calmDownAction();
        return ST_CALM_DOWN_SUGGEST;
      } else {
        return ST_NORMAL;
      }
    } else {
      return ST_NORMAL;
    }
  } else {
    _calmStart = 0;
    return ST_NORMAL;
  }
}

// ---------- Setup & Loop ----------
void setup() {
  Serial.begin(115200);
  delay(100);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_VIB, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED, LOW);
  digitalWrite(PIN_VIB, LOW);

  Wire.begin(I2C_SDA, I2C_SCL);
  SerialGPS.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  connectWiFi();
  ensureMqttConnected();
  startSensors();
  stressLogic_init();

  lastMQTTPublish = millis();
}

void loop() {
  if (mqttClient.connected()) mqttClient.loop();
  ensureMqttConnected();

  // Read sensors (placeholders / generic)
  readGPS();
  readMAX3010x(); // SpO2 - placeholder
  readMPU6050();

  // ECG BPM computation (placeholder)
  float bpm = computeBPMFromECG();
  if (bpm > 0) measuredECG_BPM = bpm;

  // Motion detection / watch BP placeholder (watch BP should update latestBPsys via BLE integration)
  bool moving = isMoving();

  // Stress logic (rule-based)
  StressState st = stressLogic_update(moving, latestBPsys, lowHRVFlag);
  if (st == ST_ESCALATE_EMERGENCY) {
    // optionally update UI
  } else if (st == ST_CALM_DOWN_SUGGEST) {
    // optional UI update
  }

  // Automatic emergency clear when conditions calm down
  if (!moving) {
    // if previously active and now safe, clear after brief stable period
    if (emergencyActive) {
      // check if vitals have returned
      if (measuredECG_BPM < BPM_STRESS_MIN && measuredSPO2 > SPO2_STRESS_MIN) {
        static unsigned long clearStart = 0;
        if (clearStart == 0) clearStart = millis();
        if (millis() - clearStart > 15000) {
          clearStart = 0;
          clearEmergency();
        }
      } else {
        // still not safe
        // reset clear timer
        // (we keep emergency active)
      }
    }
  } else {
    // if moving, do not try to clear emergency automatically
  }

  // Periodic publish
  if (millis() - lastMQTTPublish >= PUBLISH_INTERVAL) {
    lastMQTTPublish = millis();
    publishTelemetry();
    Serial.println("Published telemetry:");
    Serial.print("ECG BPM: "); Serial.println(measuredECG_BPM);
    Serial.print("SpO2: "); Serial.println(measuredSPO2);
    Serial.print("Pulse(SpO2): "); Serial.println(measuredPulseFromSpO2);
    float g = sqrt(accelX*accelX + accelY*accelY + accelZ*accelZ)/9.80665;
    Serial.print("Accel g: "); Serial.println(g);
    Serial.print("GPS: "); Serial.print(gpsLat,6); Serial.print(", "); Serial.println(gpsLng,6);
  }

  delay(20);
}
