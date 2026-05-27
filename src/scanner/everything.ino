#include <WiFi.h>
#include <PN532_I2C.h>
#include <HTTPClient.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <time.h>
#include "FS.h"
#include "LittleFS.h"
#include <WiFiClientSecure.h>
#include <Adafruit_Fingerprint.h>
#include <Adafruit_PN532.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "esp_bt.h"

// ========== LED STATE MACHINE ==========
enum LedState {
  LED_DISCONNECTED_WIFI,       // RED Solid (no WiFi) - 2 sec
  LED_DISCONNECTED_WS,         // WHITE Solid (WiFi but no WS) - 2 sec
  LED_SCANNER_CONNECTED,       // BLUE Breathing (WiFi+WS, Scanner mode) - 10 sec
  LED_SCANNER_OFFLINE,         // CYAN Breathing (No WiFi, Scanner mode) - 10 sec
  LED_ENROLL_CONNECTED,        // YELLOW Breathing (WiFi+WS, Enroll mode) - 10 sec
  LED_ENROLL_OFFLINE,          // YELLOW Breathing (No WiFi, Enroll mode) - 10 sec
  LED_SUCCESS                  // GREEN Solid (override) - 250ms
};

// ========== LED PHASE TIMING ==========
const unsigned long LED_ERROR_DURATION   = 2000;
const unsigned long LED_MODE_DURATION    = 10000;
const unsigned long LED_SUCCESS_DURATION = 250;

enum LedPhase {
  PHASE_CHECK_ERROR,
  PHASE_SHOW_MODE,
  PHASE_SUCCESS
};

#define EEPROM_SIZE 512

// ========== R503 Aura LED Constants ==========
#ifndef FINGERPRINT_LED_RED
#define FINGERPRINT_LED_RED      0x01
#endif
#ifndef FINGERPRINT_LED_BLUE
#define FINGERPRINT_LED_BLUE     0x02
#endif
#ifndef FINGERPRINT_LED_PURPLE
#define FINGERPRINT_LED_PURPLE   0x03
#endif
#ifndef FINGERPRINT_LED_GREEN
#define FINGERPRINT_LED_GREEN    0x04
#endif
#ifndef FINGERPRINT_LED_YELLOW
#define FINGERPRINT_LED_YELLOW   0x05
#endif
#ifndef FINGERPRINT_LED_CYAN
#define FINGERPRINT_LED_CYAN     0x06
#endif
#ifndef FINGERPRINT_LED_WHITE
#define FINGERPRINT_LED_WHITE    0x07
#endif

#ifndef FINGERPRINT_LED_BREATHING
#define FINGERPRINT_LED_BREATHING   0x01
#endif
#ifndef FINGERPRINT_LED_FLASHING
#define FINGERPRINT_LED_FLASHING    0x02
#endif
#ifndef FINGERPRINT_LED_ON
#define FINGERPRINT_LED_ON          0x03
#endif
#ifndef FINGERPRINT_LED_OFF
#define FINGERPRINT_LED_OFF         0x04
#endif
#ifndef FINGERPRINT_LED_GRADUAL_ON
#define FINGERPRINT_LED_GRADUAL_ON  0x05
#endif
#ifndef FINGERPRINT_LED_GRADUAL_OFF
#define FINGERPRINT_LED_GRADUAL_OFF 0x06
#endif

// ========== WEBSOCKET ==========
WebSocketsClient webSocket;

// ========== CONFIG ==========
struct Config {
  char ssid[32];
  char password[32];
  char scanner_id[32];
  char scanner_pass[32];
  char scanner_loc[32];
} config;

void saveConfig() {
  EEPROM.put(0, config);
  EEPROM.commit();
}

void loadConfig() {
  EEPROM.get(0, config);
  if (strlen(config.ssid) == 0) {
    strcpy(config.ssid,        "BraveWeb");
    strcpy(config.password,    "Br@veW3b");
    strcpy(config.scanner_id,  "1");
    strcpy(config.scanner_pass,"BluePrint");
    strcpy(config.scanner_loc, "304");
  }
}

// ========== SERVER / WS ENDPOINTS ==========
const char*    serverEndpoint = "https://blueprint.boo";
const char*    wsHost         = "blueprint.boo";
const uint16_t wsPort         = 443;
const char*    wsPath         = "/ws";

// ========== NTP ==========
const char* ntpServer        = "pool.ntp.org";
const long  gmtOffset_sec    = -8 * 3600;
const int   daylightOffset_sec = 3600;

// ========== BATTERY ==========
const int   batteryPin        = 34;
const float R1                = 38600.0;
const float R2                = 20870.0;
float       calibrationFactor = 4.138 / 5.605;
const float VREF              = 3.378;

// ========== LED GLOBALS ==========
LedState     currentLedState      = LED_DISCONNECTED_WIFI;
LedPhase     currentPhase         = PHASE_CHECK_ERROR;
unsigned long phaseStartTime      = 0;
bool          successOverrideActive = false;
unsigned long successOverrideUntil  = 0;

// ========== CONNECTIVITY GLOBALS ==========
bool websocketConnected = false;
bool WifiConnected      = false;
String authToken   = "";
String scannerDbId = "";
String mode        = "scanner";  // "scanner" | "enroll"

// ========== FINGERPRINT HARDWARE ==========
#define RX_GPIO 16
#define TX_GPIO 17
HardwareSerial       mySerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&mySerial);
bool fingerprintInitialized = false;

// ========== NFC HARDWARE ==========
#define PN532_IRQ   -1
#define PN532_RESET -1
Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);
bool           nfcInitialized = false;
unsigned long  lastNFCCheck   = 0;
const unsigned long NFC_CHECK_INTERVAL = 200;

// ========== OFFLINE LOG ==========
#define OFFLINE_LOGS_FILE "/offline_logs.bin"
#define MAX_OFFLINE_LOGS  200

struct OfflineLog {
  int  studentID;
  char method[16];
  char date[11];
  char time[9];
  char encryptedData[256];
  char iv[64];
  char authTag[64];
  char nfcDate[11];
};

// ========== STUDENT MAP ==========
#define MAX_FINGERPRINT_SLOTS 127
#define STUDENTS_BIN          "/students.bin"
int students[MAX_FINGERPRINT_SLOTS + 1] = {0};

// ========== ENROLLMENT CONTROL ==========
bool enrollmentActive    = false;
bool enrollmentCancelled = false;
int  enrollmentStudentID = 0;

// ========== PENDING LOG ==========
struct PendingLog {
  int  studentID;
  char method[16];
  bool pending;
};
PendingLog pendingLog = {0, "", false};

// ========== BUTTON ==========
#define BUTTON_PIN 25
unsigned long buttonPressStart = 0;
bool          buttonLastState  = HIGH;
bool          buttonPressed    = false;

const unsigned long SHORT_PRESS_TIME = 50;    // debounce
const unsigned long LONG_PRESS_TIME  = 1500;  // 1.5 sec  → reconnect/reauth
const unsigned long BLE_PRESS_TIME   = 5000;  // 5 sec    → enable BLE

// ========== BLE GLOBALS ==========
BLEServer*         pServer           = NULL;
BLECharacteristic* pTxCharacteristic = NULL;
bool bleDeviceConnected = false;
bool bleInitialized     = false;
bool bleModeActive = false;
bool pendingRestart = false;
unsigned long bleDisconnectTime = 0;
unsigned long bleModeStartTime = 0;
const unsigned long BLE_MIN_RUNTIME = 60000; // 60 seconds minimum
String bleBuffer = "";

// ========== FORWARD DECLARATIONS ==========
void loadStudents();
void saveStudents();
int  getNextFreeSlot();
void handleStorageFull();
void sendOutput(String msg, int commandId = -1);
void sendHeartbeat();
void handleCommand(String cmd, int commandId);
void sendLog(int studentID, String method);
void getDateTime(String &dateStr, String &timeStr);
bool signIn();
void connectWifi();
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length);
void initializeFingerprint();
void initializeNFC();
void initBLE();
uint8_t getFingerprintEnroll(int slot, int sID);
int  scanFingerprint();
int  findStudent(int fingerprintID);
void handleNFCCardNonBlocking();
String readNFCNDEFText();
void queueOfflineLog(int studentID, String method);
void queueOfflineNFCLog(String encryptedData, String iv, String authTag, String nfcDate,
                        String dateScanned, String timeScanned);
void flushOfflineLogs();
void updateLedStatus();
int  parseEnrollStudentID(String tagText);
bool clearNFCTag();
bool writeNFCText(String text);

// ========== LED CONTROL ==========
void setLedColor(LedState state) {
  if (!fingerprintInitialized) return;

  uint8_t color   = FINGERPRINT_LED_RED;
  uint8_t ledMode = FINGERPRINT_LED_ON;

  switch (state) {
    case LED_DISCONNECTED_WIFI:
      finger.LEDcontrol(FINGERPRINT_LED_ON, 0, FINGERPRINT_LED_RED);
      break;
    case LED_DISCONNECTED_WS:
      finger.LEDcontrol(FINGERPRINT_LED_ON, 0, FINGERPRINT_LED_WHITE);
      break;
    case LED_SCANNER_CONNECTED:
      finger.LEDcontrol(FINGERPRINT_LED_BREATHING, 3000, FINGERPRINT_LED_BLUE);
      break;
    case LED_SCANNER_OFFLINE:
      finger.LEDcontrol(FINGERPRINT_LED_BREATHING, 1500, FINGERPRINT_LED_CYAN);
      break;
    case LED_ENROLL_CONNECTED:
      finger.LEDcontrol(FINGERPRINT_LED_BREATHING, 3000, FINGERPRINT_LED_YELLOW);
      break;
    case LED_ENROLL_OFFLINE:
      finger.LEDcontrol(FINGERPRINT_LED_BREATHING, 1500, FINGERPRINT_LED_YELLOW);
      break;
    case LED_SUCCESS:
      finger.LEDcontrol(FINGERPRINT_LED_ON, 0, FINGERPRINT_LED_GREEN);
      break;
    default:
      finger.LEDcontrol(FINGERPRINT_LED_ON, 0, FINGERPRINT_LED_RED);
      break;
  }
}

void setLedSuccess() {
  if (!fingerprintInitialized) return;
  successOverrideActive = true;
  successOverrideUntil  = millis() + LED_SUCCESS_DURATION;
  currentLedState       = LED_SUCCESS;
  currentPhase          = PHASE_SUCCESS;
  setLedColor(LED_SUCCESS);
}

LedState getDesiredModeState() {
  if (WifiConnected && websocketConnected) {
    return (mode == "enroll") ? LED_ENROLL_CONNECTED : LED_SCANNER_CONNECTED;
  } else if (WifiConnected && !websocketConnected) {
    return LED_DISCONNECTED_WS;
  } else {
    return (mode == "enroll") ? LED_ENROLL_OFFLINE : LED_SCANNER_OFFLINE;
  }
}

void updateLedStatus() {
  if (!fingerprintInitialized) return;
  unsigned long now = millis();

  if (successOverrideActive) {
    if (now >= successOverrideUntil) {
      successOverrideActive = false;
      currentPhase          = PHASE_CHECK_ERROR;
      phaseStartTime        = now;
    }
    return;
  }

  if (currentPhase == PHASE_CHECK_ERROR) {
    if (!WifiConnected) {
      if (currentLedState != LED_DISCONNECTED_WIFI) {
        currentLedState = LED_DISCONNECTED_WIFI;
        setLedColor(LED_DISCONNECTED_WIFI);
        phaseStartTime = now;
      }
      if (now - phaseStartTime >= LED_ERROR_DURATION) {
        currentPhase   = PHASE_SHOW_MODE;
        phaseStartTime = now;
      }
    } else if (!websocketConnected) {
      if (currentLedState != LED_DISCONNECTED_WS) {
        currentLedState = LED_DISCONNECTED_WS;
        setLedColor(LED_DISCONNECTED_WS);
        phaseStartTime = now;
      }
      if (now - phaseStartTime >= LED_ERROR_DURATION) {
        currentPhase   = PHASE_SHOW_MODE;
        phaseStartTime = now;
      }
    } else {
      currentPhase   = PHASE_SHOW_MODE;
      phaseStartTime = now;
    }
  } else if (currentPhase == PHASE_SHOW_MODE) {
    LedState desired = getDesiredModeState();
    if (currentLedState != desired) {
      currentLedState = desired;
      setLedColor(desired);
      phaseStartTime = now;
    }
    if (now - phaseStartTime >= LED_MODE_DURATION) {
      currentPhase   = PHASE_CHECK_ERROR;
      phaseStartTime = now;
    }
  }
}

// ========== BLE UUIDS ==========
#define SERVICE_UUID           "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID_TX "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define CHARACTERISTIC_UUID_RX "e3223119-9445-4e96-a4a1-85358c4046a2"

// ========== BLE CALLBACKS ==========
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleDeviceConnected = true;
    Serial.println("[BLE] Phone Connected!");
  }
  void onDisconnect(BLEServer* pServer) {
    bleDeviceConnected = false;

    Serial.println("[BLE] Phone Disconnected!");

    bleDisconnectTime = millis();
  }
};

void stopBLE() {
  if (!bleInitialized) return;

  Serial.println("[BLE] Stopping BLE...");

  // Stop advertising first
  BLEDevice::getAdvertising()->stop();

  delay(200);

  // Fully deinitialize BT stack
  BLEDevice::deinit(true);

  // IMPORTANT: clear dangling pointers
  pServer = nullptr;
  pTxCharacteristic = nullptr;

  bleInitialized = false;
  bleDeviceConnected = false;
  bleModeActive = false;

  delay(500);

  Serial.println("[BLE] BLE stopped");
}

void parseConfigPair(String pair);
void parseConfiguration(String configString);

class MyCharacteristicCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) override {

    String rxValue = pCharacteristic->getValue();
    rxValue.trim();

    if (rxValue.length() == 0) return;

    Serial.println("[BLE CHUNK] " + rxValue);

    bleBuffer += rxValue;

    if (bleBuffer.indexOf("CONFIG_END") != -1) {

      Serial.println("[BLE] FULL CONFIG RECEIVED:");
      Serial.println(bleBuffer);

      parseConfiguration(bleBuffer);

      if (pTxCharacteristic) {
        pTxCharacteristic->setValue("CONFIG:OK");
        pTxCharacteristic->notify();
      }

      bleBuffer = "";
    }
  }
};

// ========== BLE INIT ==========
void initBLE() {
  if (bleInitialized) {
    Serial.println("[BLE] Already initialized");
    return;
  }

  Serial.println("[BLE] Preparing for BLE mode...");

  // ===== DISCONNECT NETWORKING =====
  websocketConnected = false;

  webSocket.disconnect();

  delay(200);

  WiFi.disconnect(true, true);
  WiFi.mode(WIFI_OFF);

  WifiConnected = false;

  delay(500);

  Serial.println("[BLE] WiFi + WebSocket stopped");

  // ===== START BLE =====
  Serial.println("[BLE] Starting Bluetooth...");
  Serial.printf("[BLE] Free heap before BLE: %u\n", ESP.getFreeHeap());

  BLEDevice::init("ESP32-BluePrint_Scanner");

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID_TX,
      BLECharacteristic::PROPERTY_NOTIFY
  );

  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic *pRxCharacteristic = pService->createCharacteristic(
      CHARACTERISTIC_UUID_RX,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );

  pRxCharacteristic->setCallbacks(new MyCharacteristicCallbacks());

  pService->start();

  BLEDevice::setMTU(185);

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->start();

  bleInitialized = true;
  bleModeStartTime = millis();
  bleModeActive = true;

  Serial.println("[BLE] Advertising started");
}

// ========== BLE CONFIG PARSING ==========
void parseConfigPair(String pair) {
  pair.trim();
  int eqIdx = pair.indexOf('=');
  if (eqIdx == -1) return;

  String key   = pair.substring(0, eqIdx);
  String value = pair.substring(eqIdx + 1);
  key.trim();
  value.trim();
  if (value.startsWith("\"")) value = value.substring(1);
  if (value.endsWith("\""))   value = value.substring(0, value.length() - 1);

  if (key == "SCANNER_ID") {
    strncpy(config.scanner_id, value.c_str(), sizeof(config.scanner_id) - 1);
    config.scanner_id[sizeof(config.scanner_id) - 1] = '\0';
    Serial.print("[BLE] Scanner ID set to: "); Serial.println(value);
  } else if (key == "SCANNER_PASSWORD") {
    strncpy(config.scanner_pass, value.c_str(), sizeof(config.scanner_pass) - 1);
    config.scanner_pass[sizeof(config.scanner_pass) - 1] = '\0';
    Serial.println("[BLE] Scanner Password set");
  } else if (key == "SCANNER_LOC") {
    strncpy(config.scanner_loc, value.c_str(), sizeof(config.scanner_loc) - 1);
    config.scanner_loc[sizeof(config.scanner_loc) - 1] = '\0';
    Serial.print("[BLE] Scanner Location set to: "); Serial.println(value);
  } else if (key == "SSID") {
    strncpy(config.ssid, value.c_str(), sizeof(config.ssid) - 1);
    config.ssid[sizeof(config.ssid) - 1] = '\0';
    Serial.print("[BLE] WiFi SSID set to: "); Serial.println(value);
  } else if (key == "WIFI_PASS") {
    strncpy(config.password, value.c_str(), sizeof(config.password) - 1);
    config.password[sizeof(config.password) - 1] = '\0';
    Serial.println("[BLE] WiFi Password set");
  }
}

void parseConfiguration(String configString) {

  configString.replace("CONFIG_START", "");
  configString.replace("CONFIG_END", "");
  configString.trim();

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, configString);

  if (err) {
    Serial.println("[BLE] JSON parse failed");
    Serial.println(err.c_str());
    return;
  }

  if (doc.containsKey("scanner_id")) {
    strncpy(config.scanner_id, doc["scanner_id"], sizeof(config.scanner_id));
  }

  if (doc.containsKey("scanner_pass")) {
    strncpy(config.scanner_pass, doc["scanner_pass"], sizeof(config.scanner_pass));
  }

  if (doc.containsKey("scanner_loc")) {
    strncpy(config.scanner_loc, doc["scanner_loc"], sizeof(config.scanner_loc));
  }

  if (doc.containsKey("ssid")) {
    strncpy(config.ssid, doc["ssid"], sizeof(config.ssid));
  }

  if (doc.containsKey("wifi_pass")) {
    strncpy(config.password, doc["wifi_pass"], sizeof(config.password));
  }

  saveConfig();

  Serial.println("[BLE] Config updated successfully");

  if (pTxCharacteristic) {
    pTxCharacteristic->setValue("CONFIG:OK:RESTARTING");
    pTxCharacteristic->notify();
  }

  pendingRestart = true;
}

// ========== FINGERPRINT INIT ==========
void initializeFingerprint() {
  mySerial.begin(57600, SERIAL_8N1, RX_GPIO, TX_GPIO);
  delay(5);
  finger.begin(57600);
  delay(100);
  if (finger.verifyPassword()) {
    Serial.println("✓ Found fingerprint sensor!");
    fingerprintInitialized = true;
    currentPhase   = PHASE_CHECK_ERROR;
    phaseStartTime = millis();
  } else {
    Serial.println("✗ Did not find fingerprint sensor :(");
    fingerprintInitialized = false;
  }
}

// ========== NFC INIT ==========
void initializeNFC() {
  Wire.begin(21, 22);
  nfc.begin();
  uint32_t versiondata = nfc.getFirmwareVersion();
  if (!versiondata) {
    Serial.println("✗ Did not find PN532 NFC board");
    nfcInitialized = false;
    return;
  }
  nfc.SAMConfig();
  nfcInitialized = true;
  Serial.println("✓ NFC scanner initialized.");
}

// ========== BUTTON HANDLER ==========
void handleButton() {
  bool currentState = digitalRead(BUTTON_PIN);

  if (buttonLastState == HIGH && currentState == LOW) {
    buttonPressStart = millis();
    buttonPressed    = true;
  }

  if (buttonLastState == LOW && currentState == HIGH && buttonPressed) {
    unsigned long pressDuration = millis() - buttonPressStart;
    buttonPressed = false;

    if (pressDuration > SHORT_PRESS_TIME && pressDuration < LONG_PRESS_TIME) {
      // ── Short press: cancel enrollment or toggle mode ──
      if (enrollmentActive) {
        enrollmentCancelled = true;
        sendOutput("Enrollment cancelled (button).", -1);
        return;
      }
      if (mode == "scanner") {
        mode = "enroll";
        sendOutput("Mode set to enroll (button)", -1);
      } else {
        mode = "scanner";
        sendOutput("Mode set to scanner (button)", -1);
      }
    }
    /*else if (pressDuration >= LONG_PRESS_TIME && pressDuration < BLE_PRESS_TIME) {
      // ── 1.5–5 sec: manual reconnect + reauth ──
      sendOutput("Manual reconnect + reauth...", -1);
      connectWifi();
      if (signIn()) {
        flushOfflineLogs();
      }
    }*/
    else if (pressDuration >= BLE_PRESS_TIME) {
      // ── 5+ sec: enable BLE for configuration ──
      Serial.println("[BUTTON] 5-second hold detected — enabling BLE...");
      initBLE();
    }
  }

  buttonLastState = currentState;
}

// ========== STUDENT MAP ==========
void loadStudents() {
  File file = LittleFS.open(STUDENTS_BIN, FILE_READ);
  if (file) {
    file.read((uint8_t*)students, sizeof(students));
    file.close();
    Serial.println("[STORAGE] Student map loaded from LittleFS.");
  } else {
    Serial.println("[STORAGE] No student map found, starting fresh.");
    memset(students, 0, sizeof(students));
  }
}

void saveStudents() {
  File file = LittleFS.open(STUDENTS_BIN, FILE_WRITE);
  if (!file) {
    Serial.println("[STORAGE] ERROR: Could not write student map!");
    return;
  }
  file.write((uint8_t*)students, sizeof(students));
  file.close();
  Serial.println("[STORAGE] Student map saved to LittleFS.");
}

int getNextFreeSlot() {
  for (int slot = 1; slot <= MAX_FINGERPRINT_SLOTS; slot++) {
    if (students[slot] == 0) return slot;
  }
  return -1;
}

void handleStorageFull() {
  Serial.println("[STORAGE] No free fingerprint slots!");
  sendOutput("No free fingerprint slots! Use 'slots clear all' to reset.", -1);
}

int findStudent(int fingerprintID) {
  if (fingerprintID < 1 || fingerprintID > MAX_FINGERPRINT_SLOTS) return -1;
  return students[fingerprintID];
}

// ========== FINGERPRINT SCAN & ENROLL ==========
int scanFingerprint() {
  uint8_t p = finger.getImage();
  if (p != FINGERPRINT_OK) return -1;
  p = finger.image2Tz();
  if (p != FINGERPRINT_OK) return -1;
  p = finger.fingerSearch();
  if (p != FINGERPRINT_OK) return -1;
  return finger.fingerID;
}

static inline void wsFlush() {
  for (int i = 0; i < 10; i++) { webSocket.loop(); delay(10); }
}

uint8_t getFingerprintEnroll(int slot, int sID) {
  int p = -1;
  enrollmentActive    = true;
  enrollmentCancelled = false;
  enrollmentStudentID = sID;

  sendOutput("Place finger on sensor for student " + String(sID) + "...", -1);
  sendOutput("Type 'cancel' to abort enrollment.", -1);
  wsFlush();

  while (p != FINGERPRINT_OK) {
    webSocket.loop();
    updateLedStatus();
    if (enrollmentCancelled) {
      enrollmentActive = false;
      sendOutput("Enrollment cancelled.", -1);
      return 0xFF;
    }
    p = finger.getImage();
    if (p == FINGERPRINT_NOFINGER) continue;
    if (p != FINGERPRINT_OK) continue;
  }

  p = finger.image2Tz(1);
  if (p != FINGERPRINT_OK) {
    sendOutput("First scan failed — try again.", -1);
    wsFlush(); delay(3000);
    enrollmentActive = false;
    return p;
  }

  sendOutput("Good scan. Lift your finger.", -1);
  setLedSuccess();
  wsFlush();
  delay(1000);
  while (finger.getImage() != FINGERPRINT_NOFINGER) {
    updateLedStatus();
    webSocket.loop();
  }

  p = -1;
  sendOutput("Place the SAME finger again to confirm...", -1);
  wsFlush();

  while (p != FINGERPRINT_OK) {
    updateLedStatus();
    webSocket.loop();
    if (enrollmentCancelled) {
      enrollmentActive = false;
      sendOutput("Enrollment cancelled.", -1);
      return 0xFF;
    }
    p = finger.getImage();
    if (p == FINGERPRINT_NOFINGER) continue;
    if (p != FINGERPRINT_OK) continue;
  }

  p = finger.image2Tz(2);
  if (p != FINGERPRINT_OK) {
    sendOutput("Second scan failed. Try again.", -1);
    wsFlush(); delay(3000);
    enrollmentActive = false;
    return p;
  }

  p = finger.createModel();
  if (p == FINGERPRINT_ENROLLMISMATCH) {
    sendOutput("Fingerprints did not match — please retry.", -1);
    wsFlush(); delay(3000);
    enrollmentActive = false;
    return p;
  }
  if (p != FINGERPRINT_OK) {
    sendOutput("Model creation failed (error " + String(p) + ").", -1);
    wsFlush(); delay(3000);
    enrollmentActive = false;
    return p;
  }

  p = finger.storeModel(slot);
  if (p != FINGERPRINT_OK) {
    sendOutput("Failed to store fingerprint (error " + String(p) + ").", -1);
    wsFlush(); delay(3000);
    enrollmentActive = false;
    return p;
  }

  students[slot] = sID;
  saveStudents();
  sendOutput("✓ Enrollment complete! Student " + String(sID) + " saved to slot " + String(slot) + ".", -1);
  setLedSuccess();
  delay(500);
  finger.LEDcontrol(FINGERPRINT_LED_BREATHING, 0, FINGERPRINT_LED_YELLOW);
  delay(500);
  setLedSuccess();
  wsFlush();

  enrollmentActive = false;
  return FINGERPRINT_OK;
}

// ========== SERVER COMMUNICATION ==========
bool signIn() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(10000);
  String url = String(serverEndpoint) + "/api/scanner/auth/login";
  if (!http.begin(client, url)) { http.end(); return false; }
  http.addHeader("Content-Type", "application/json");
  StaticJsonDocument<256> doc;
  doc["SCANNER_ID"]       = config.scanner_id;
  doc["SCANNER_LOCATION"] = config.scanner_loc;
  doc["SCANNER_PASSWORD"] = config.scanner_pass;
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  if (code == 200) {
    String response = http.getString();
    StaticJsonDocument<512> resp;
    deserializeJson(resp, response);
    authToken   = resp["token"].as<String>();
    scannerDbId = resp["user"]["id"].as<String>();
    Serial.println("✓ Scanner authenticated.");
    http.end();
    return true;
  }
  Serial.printf("[AUTH] Sign in failed, HTTP %d\n", code);
  http.end();
  return false;
}

void getDateTime(String &dateStr, String &timeStr) {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 0)) {
    dateStr = "0000-00-00";
    timeStr = "00:00:00";
    return;
  }
  char dateBuffer[11], timeBuffer[9];
  strftime(dateBuffer, sizeof(dateBuffer), "%Y-%m-%d", &timeinfo);
  strftime(timeBuffer, sizeof(timeBuffer), "%H:%M:%S", &timeinfo);
  dateStr = String(dateBuffer);
  timeStr = String(timeBuffer);
}

void sendLog(int studentID, String method) {
  if (WiFi.status() != WL_CONNECTED || authToken == "") {
    queueOfflineLog(studentID, method);
    return;
  }
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(5000);
  if (!http.begin(client, String(serverEndpoint) + "/api/logs")) {
    queueOfflineLog(studentID, method);
    http.end();
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + authToken);
  String dateStr, timeStr;
  getDateTime(dateStr, timeStr);
  StaticJsonDocument<256> doc;
  doc["scanner_location"] = config.scanner_loc;
  doc["scanner_id"]       = config.scanner_id;
  doc["student_id"]       = studentID;
  doc["date_scanned"]     = dateStr;
  doc["time_scanned"]     = timeStr;
  doc["status"]           = "null";
  doc["method"]           = method;
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  if (code != 201) queueOfflineLog(studentID, method);
  http.end();
}

void sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED || authToken == "" || scannerDbId == "") return;
  int raw = analogRead(batteryPin);
  float voltageAtPin   = (raw / 4095.0) * VREF;
  float batteryVoltage = voltageAtPin * ((R1 + R2) / R2) * calibrationFactor;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(2000);
  if (!http.begin(client, String(serverEndpoint) + "/api/scanners/" + scannerDbId + "/heartbeat")) {
    http.end(); return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + authToken);
  StaticJsonDocument<128> doc;
  doc["battery_level"] = batteryVoltage;
  String body;
  serializeJson(doc, body);
  int code = http.POST(body);
  if (code == 401) {
    authToken = "";
    Serial.println("[HEARTBEAT] 401 Unauthorized — token cleared.");
  }
  http.end();
}

void sendOutput(String msg, int commandId) {
  if (!webSocket.isConnected()) return;
  StaticJsonDocument<256> doc;
  doc["type"]      = "output";
  doc["scannerId"] = scannerDbId;
  doc["output"]    = msg;
  doc["mode"]      = mode;
  doc["commandId"] = commandId;
  String body;
  serializeJson(doc, body);
  webSocket.sendTXT(body);
}

// ========== COMMAND HANDLING ==========
void handleCommand(String cmd, int commandId) {
  cmd.trim();
  Serial.printf("[CMD] Processing: '%s' (ID: %d)\n", cmd.c_str(), commandId);

  if (cmd.startsWith("set mode ")) {
    String newMode = cmd.substring(9);
    newMode.trim();
    if (newMode == "scanner" || newMode == "enroll") {
      mode = newMode;
      sendOutput("Mode set to " + newMode, commandId);
    } else {
      sendOutput("Invalid mode. Use 'scanner' or 'enroll'.", commandId);
    }
    return;
  }

  if (cmd == "cancel") {
    if (enrollmentActive) {
      enrollmentCancelled = true;
      Serial.println("[CMD] Cancel flag set.");
    } else {
      sendOutput("No active enrollment to cancel.", commandId);
    }
    return;
  }

  if (cmd == "status") {
    String msg  = "Status:\n";
    msg += "Mode: " + mode + "\n";
    msg += "WiFi: " + String(WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected") + "\n";
    msg += "IP: " + WiFi.localIP().toString() + "\n";
    msg += "Fingerprint: " + String(fingerprintInitialized ? "OK" : "NOT FOUND") + "\n";
    msg += "NFC: " + String(nfcInitialized ? "OK" : "NOT FOUND") + "\n";
    msg += "BLE: " + String(bleInitialized ? "Active" : "Off") + "\n";
    msg += "Auth: " + String(authToken != "" ? "OK" : "NOT AUTHENTICATED");
    sendOutput(msg, commandId);
    return;
  }

  if (cmd == "ping") {
    sendOutput("pong", commandId);
    return;
  }

  if (cmd == "wifi info") {
    String msg  = "WiFi Info:\n";
    msg += "SSID: " + String(WiFi.SSID()) + "\n";
    msg += "IP: " + WiFi.localIP().toString() + "\n";
    msg += "RSSI: " + String(WiFi.RSSI()) + " dBm";
    sendOutput(msg, commandId);
    return;
  }

  if (cmd == "restart") {
    sendOutput("Restarting device...", commandId);
    delay(500);
    ESP.restart();
  }

  if (cmd == "reauth") {
    if (signIn()) {
      sendOutput("Re-authentication successful.", commandId);
      if (webSocket.isConnected()) {
        StaticJsonDocument<256> doc;
        doc["type"]      = "auth";
        doc["scannerId"] = scannerDbId;
        doc["token"]     = authToken;
        String msg;
        serializeJson(doc, msg);
        webSocket.sendTXT(msg);
      }
    } else {
      sendOutput("Re-authentication FAILED.", commandId);
    }
    return;
  }

  if (cmd == "ble on") {
    initBLE();
    return;
  }

  if (cmd == "slots list") {
    String msg  = "Slots:\n";
    int count = 0;
    for (int i = 1; i <= MAX_FINGERPRINT_SLOTS; i++) {
      if (students[i] != 0) {
        msg += "Slot " + String(i) + " → " + String(students[i]) + "\n";
        count++;
      }
    }
    if (count == 0) msg = "No fingerprints stored.";
    sendOutput(msg, commandId);
    return;
  }

  if (cmd == "slots clear all") {
    memset(students, 0, sizeof(students));
    if (finger.emptyDatabase() == FINGERPRINT_OK) {
      saveStudents();
      sendOutput("All slots cleared.", commandId);
    } else {
      sendOutput("Failed to clear sensor.", commandId);
    }
    return;
  }

  if (cmd.startsWith("slots clear ")) {
    int slot = cmd.substring(12).toInt();
    if (slot >= 1 && slot <= MAX_FINGERPRINT_SLOTS) {
      if (students[slot] != 0) {
        int oldID = students[slot];
        students[slot] = 0;
        saveStudents();
        sendOutput("Cleared slot " + String(slot) + " (Student " + String(oldID) + ")", commandId);
      } else {
        sendOutput("Slot already empty.", commandId);
      }
    } else {
      sendOutput("Invalid slot number.", commandId);
    }
    return;
  }

  if (cmd.startsWith("slots get ")) {
    int slot = cmd.substring(10).toInt();
    if (slot >= 1 && slot <= MAX_FINGERPRINT_SLOTS) {
      if (students[slot] != 0) {
        sendOutput("Slot " + String(slot) + " → Student " + String(students[slot]), commandId);
      } else {
        sendOutput("Slot is empty.", commandId);
      }
    } else {
      sendOutput("Invalid slot.", commandId);
    }
    return;
  }

  if (cmd.startsWith("student delete ")) {
    int studentID = cmd.substring(15).toInt();
    bool found = false;
    for (int i = 1; i <= MAX_FINGERPRINT_SLOTS; i++) {
      if (students[i] == studentID) {
        students[i] = 0;
        saveStudents();
        sendOutput("Deleted student " + String(studentID) + " from slot " + String(i), commandId);
        found = true;
        break;
      }
    }
    if (!found) sendOutput("Student not found.", commandId);
    return;
  }

  if (cmd == "test scan") {
    sendOutput("Testing fingerprint...", commandId);
    int fingerID = scanFingerprint();
    if (fingerID >= 0) {
      sendOutput("Fingerprint detected! ID: " + String(fingerID), commandId);
    } else {
      sendOutput("No fingerprint detected.", commandId);
    }
    return;
  }

  // ── Numeric: manual log or enroll ──
  bool isNumeric = true;
  for (unsigned int i = 0; i < cmd.length(); i++) {
    if (!isdigit(cmd[i])) { isNumeric = false; break; }
  }

  if (isNumeric && cmd.length() > 0) {
    int studentID = cmd.toInt();
    if (mode == "enroll") {
      int slot = getNextFreeSlot();
      if (slot == -1) {
        handleStorageFull();
        sendOutput("No free slots.", commandId);
        return;
      }
      sendOutput("Starting enrollment for student " + String(studentID) + "...", commandId);
      wsFlush();
      uint8_t result = getFingerprintEnroll(slot, studentID);
      if (result == FINGERPRINT_OK) {
        sendOutput("Enrollment successful (slot " + String(slot) + ")", commandId);
      } else {
        sendOutput("Enrollment failed.", commandId);
      }
    } else {
      sendLog(studentID, "manual");
      sendOutput("Manual log for student " + String(studentID), commandId);
    }
    return;
  }

  sendOutput("Unknown command: " + cmd, commandId);
}

// ========== WEBSOCKET EVENT HANDLER ==========
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      Serial.println("WebSocket connected.");
      webSocket.enableHeartbeat(25000, 5000, 3);
      websocketConnected = true;
      StaticJsonDocument<256> doc;
      doc["type"]      = "auth";
      doc["scannerId"] = scannerDbId;
      doc["token"]     = authToken;
      String msg;
      serializeJson(doc, msg);
      webSocket.sendTXT(msg);
      break;
    }
    case WStype_DISCONNECTED:
      Serial.println("WebSocket disconnected.");
      websocketConnected = false;
      // setReconnectInterval handles automatic reconnection — no manual beginSSL needed here
      break;
    case WStype_TEXT: {
      String data = (char*)payload;
      Serial.printf("[WS] Raw payload: %s\n", data.c_str());
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, data);
      if (err) {
        Serial.printf("[WS] JSON parse error: %s\n", err.c_str());
        break;
      }
      String command  = doc["command"]   | "";
      int    commandId = doc["commandId"] | 0;
      if (command != "") {
        handleCommand(command, commandId);
      }
      break;
    }
    case WStype_PONG:
      Serial.println("[WS] Pong received");
      break;
    case WStype_ERROR:
      Serial.println("WebSocket error.");
      break;
    default:
      break;
  }
}

void connectWifi() {
  Serial.printf("[WIFI] Connecting to %s\n", config.ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(config.ssid, config.password);
  WifiConnected = false;
}

// ========== OFFLINE LOGGING ==========
void queueOfflineLog(int studentID, String method) {
  String dateStr, timeStr;
  getDateTime(dateStr, timeStr);

  OfflineLog entry;
  memset(&entry, 0, sizeof(entry));
  entry.studentID = studentID;
  strncpy(entry.method, method.c_str(), sizeof(entry.method) - 1);
  strncpy(entry.date,   dateStr.c_str(), sizeof(entry.date) - 1);
  strncpy(entry.time,   timeStr.c_str(), sizeof(entry.time) - 1);

  int count = 0;
  File rf = LittleFS.open(OFFLINE_LOGS_FILE, FILE_READ);
  if (rf) { count = rf.size() / sizeof(OfflineLog); rf.close(); }

  if (count >= MAX_OFFLINE_LOGS) {
    Serial.println("[OFFLINE] Queue full — dropping oldest log.");
    OfflineLog* buf = (OfflineLog*)malloc(sizeof(OfflineLog) * MAX_OFFLINE_LOGS);
    if (!buf) return;
    File r2 = LittleFS.open(OFFLINE_LOGS_FILE, FILE_READ);
    if (r2) { r2.read((uint8_t*)buf, sizeof(OfflineLog) * MAX_OFFLINE_LOGS); r2.close(); }
    File w2 = LittleFS.open(OFFLINE_LOGS_FILE, FILE_WRITE);
    if (w2) {
      w2.write((uint8_t*)&buf[1], sizeof(OfflineLog) * (MAX_OFFLINE_LOGS - 1));
      w2.write((uint8_t*)&entry,  sizeof(OfflineLog));
      w2.close();
    }
    free(buf);
    return;
  }

  File f = LittleFS.open(OFFLINE_LOGS_FILE, FILE_APPEND);
  if (!f) { Serial.println("[OFFLINE] ERROR: Could not open offline log file."); return; }
  f.write((uint8_t*)&entry, sizeof(OfflineLog));
  f.close();
  Serial.printf("[OFFLINE] Queued log: student=%d method=%s\n", studentID, method.c_str());
}

void queueOfflineNFCLog(String encryptedData, String iv, String authTag, String nfcDate,
                        String dateScanned, String timeScanned) {
  OfflineLog entry;
  memset(&entry, 0, sizeof(entry));
  entry.studentID = -1;
  strncpy(entry.method,        "nfc",                sizeof(entry.method) - 1);
  strncpy(entry.date,          dateScanned.c_str(),   sizeof(entry.date) - 1);
  strncpy(entry.time,          timeScanned.c_str(),   sizeof(entry.time) - 1);
  strncpy(entry.encryptedData, encryptedData.c_str(), sizeof(entry.encryptedData) - 1);
  strncpy(entry.iv,            iv.c_str(),             sizeof(entry.iv) - 1);
  strncpy(entry.authTag,       authTag.c_str(),         sizeof(entry.authTag) - 1);
  strncpy(entry.nfcDate,       nfcDate.c_str(),         sizeof(entry.nfcDate) - 1);

  int count = 0;
  File rf = LittleFS.open(OFFLINE_LOGS_FILE, FILE_READ);
  if (rf) { count = rf.size() / sizeof(OfflineLog); rf.close(); }

  if (count >= MAX_OFFLINE_LOGS) {
    OfflineLog* buf = (OfflineLog*)malloc(sizeof(OfflineLog) * MAX_OFFLINE_LOGS);
    if (!buf) return;
    File r2 = LittleFS.open(OFFLINE_LOGS_FILE, FILE_READ);
    if (r2) { r2.read((uint8_t*)buf, sizeof(OfflineLog) * MAX_OFFLINE_LOGS); r2.close(); }
    File w2 = LittleFS.open(OFFLINE_LOGS_FILE, FILE_WRITE);
    if (w2) {
      w2.write((uint8_t*)&buf[1], sizeof(OfflineLog) * (MAX_OFFLINE_LOGS - 1));
      w2.write((uint8_t*)&entry,  sizeof(OfflineLog));
      w2.close();
    }
    free(buf);
    return;
  }

  File f = LittleFS.open(OFFLINE_LOGS_FILE, FILE_APPEND);
  if (!f) return;
  f.write((uint8_t*)&entry, sizeof(OfflineLog));
  f.close();
  Serial.println("[OFFLINE] Queued NFC log (encrypted).");
}

void flushOfflineLogs() {
  if (!LittleFS.exists(OFFLINE_LOGS_FILE)) return;
  File f = LittleFS.open(OFFLINE_LOGS_FILE, FILE_READ);
  if (!f) return;
  int count = f.size() / sizeof(OfflineLog);
  if (count == 0) { f.close(); return; }

  Serial.printf("[OFFLINE] Flushing %d queued log(s)...\n", count);
  sendOutput("Flushing " + String(count) + " offline log(s)...", -1);

  int sent = 0, failed = 0;
  for (int i = 0; i < count; i++) {
    OfflineLog entry;
    f.read((uint8_t*)&entry, sizeof(OfflineLog));

    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setTimeout(10000);

    bool isNFC = (strcmp(entry.method, "nfc") == 0);
    String endpoint = isNFC
      ? String(serverEndpoint) + "/api/scanner/log"
      : String(serverEndpoint) + "/api/logs";

    if (!http.begin(client, endpoint)) { failed++; http.end(); continue; }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " + authToken);

    String body;
    if (isNFC) {
      StaticJsonDocument<512> doc;
      doc["encryptedData"]    = entry.encryptedData;
      doc["iv"]               = entry.iv;
      doc["authTag"]          = entry.authTag;
      doc["date"]             = entry.nfcDate;
      doc["scanner_location"] = config.scanner_loc;
      doc["scanner_id"]       = config.scanner_id;
      doc["date_scanned"]     = entry.date;
      doc["time_scanned"]     = entry.time;
      serializeJson(doc, body);
    } else {
      StaticJsonDocument<256> doc;
      doc["scanner_location"] = config.scanner_loc;
      doc["scanner_id"]       = config.scanner_id;
      doc["student_id"]       = entry.studentID;
      doc["date_scanned"]     = entry.date;
      doc["time_scanned"]     = entry.time;
      doc["status"]           = "null";
      doc["method"]           = entry.method;
      serializeJson(doc, body);
    }

    int code = http.POST(body);
    if (code == 201) { sent++; }
    else {
      Serial.printf("[OFFLINE] Failed for student %d (HTTP %d)\n", entry.studentID, code);
      failed++;
    }
    http.end();
    webSocket.loop();
  }
  f.close();

  if (failed == 0) {
    LittleFS.remove(OFFLINE_LOGS_FILE);
    Serial.println("[OFFLINE] All queued logs sent. File cleared.");
    sendOutput("All offline logs flushed successfully.", -1);
  } else {
    Serial.printf("[OFFLINE] %d sent, %d failed — will retry.\n", sent, failed);
    sendOutput(String(sent) + " sent, " + String(failed) + " failed — will retry.", -1);
  }
}

// ========== NFC HELPERS ==========
String readNFCNDEFText() {
  uint8_t buf[96];
  int idx = 0;
  for (int page = 4; page <= 27; page++) {
    uint8_t pageData[4];
    if (nfc.ntag2xx_ReadPage(page, pageData)) {
      for (int i = 0; i < 4; i++) buf[idx++] = pageData[i];
    } else break;
  }
  for (int i = 0; i < idx - 2; i++) {
    if (buf[i] == 0x03) {
      uint8_t msgLen = buf[i + 1];
      int start = i + 2;
      if (start + msgLen > idx) break;
      uint8_t* rec     = &buf[start];
      uint8_t  tnf     = rec[0] & 0x07;
      bool     sr      = rec[0] & 0x10;
      uint8_t  typeLen = rec[1];
      if (tnf == 0x01 && typeLen == 1) {
        uint8_t type = rec[sr ? 3 : 6];
        if (type == 'T') {
          uint8_t  status     = rec[(sr ? 4 : 7)];
          uint8_t  langLen    = status & 0x3F;
          uint32_t payloadLen = sr ? rec[2] : (rec[2] << 24 | rec[3] << 16 | rec[4] << 8 | rec[5]);
          uint8_t* textStart  = &rec[(sr ? 4 : 7) + 1 + langLen];
          uint32_t textLen    = payloadLen - (1 + langLen);
          String result;
          for (uint32_t j = 0; j < textLen; j++) result += (char)textStart[j];
          return result;
        }
      }
      break;
    }
  }
  return "";
}

bool clearNFCTag() {
  uint8_t blank[4] = {0x00, 0x00, 0x00, 0x00};
  uint8_t term[4]  = {0xFE, 0x00, 0x00, 0x00};
  if (!nfc.ntag2xx_WritePage(4, term)) return false;
  for (int page = 5; page <= 7; page++) {
    if (!nfc.ntag2xx_WritePage(page, blank)) return false;
  }
  Serial.println("[NFC] Tag cleared.");
  return true;
}

bool writeNFCText(String text) {
  uint8_t textLen    = text.length();
  uint8_t payloadLen = 3 + textLen;
  uint8_t msgLen     = 3 + payloadLen;
  uint8_t buf[16]    = {0};
  int i = 0;
  buf[i++] = 0x03;
  buf[i++] = msgLen;
  buf[i++] = 0xD1;
  buf[i++] = 0x01;
  buf[i++] = payloadLen;
  buf[i++] = 'T';
  buf[i++] = 0x02;
  buf[i++] = 'e';
  buf[i++] = 'n';
  for (int j = 0; j < textLen && i < 15; j++) buf[i++] = text[j];
  buf[i] = 0xFE;
  for (int page = 4; page <= 7; page++) {
    uint8_t pageData[4];
    memcpy(pageData, &buf[(page - 4) * 4], 4);
    if (!nfc.ntag2xx_WritePage(page, pageData)) {
      Serial.println("[NFC] Write failed on page " + String(page));
      return false;
    }
  }
  return true;
}

int parseEnrollStudentID(String tagText) {
  tagText.trim();
  bool numeric = true;
  for (unsigned int i = 0; i < tagText.length(); i++) {
    if (!isdigit(tagText[i])) { numeric = false; break; }
  }
  if (numeric && tagText.length() > 0) return tagText.toInt();
  int colon = tagText.indexOf(':');
  if (colon >= 0) {
    String value = tagText.substring(colon + 1);
    value.trim();
    bool valueNumeric = true;
    for (unsigned int i = 0; i < value.length(); i++) {
      if (!isdigit(value[i])) { valueNumeric = false; break; }
    }
    if (valueNumeric && value.length() > 0) return value.toInt();
  }
  return -1;
}

void handleNFCCardNonBlocking() {
  unsigned long now = millis();
  if (now - lastNFCCheck < NFC_CHECK_INTERVAL) return;
  lastNFCCheck = now;

  uint8_t uid[7];
  uint8_t uidLen = 0;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 50)) return;

  String tagText = readNFCNDEFText();
  if (tagText.length() == 0) return;
  tagText.trim();

  if (mode == "enroll") {
    if (enrollmentActive) return;
    int studentID = parseEnrollStudentID(tagText);
    if (studentID <= 0) return;
    int slot = getNextFreeSlot();
    if (slot == -1) {
      handleStorageFull();
      return;
    }
    sendOutput("NFC enroll tag read. Starting enrollment for student " + String(studentID) + "...", -1);
    writeNFCText(" ");
    uint8_t result = getFingerprintEnroll(slot, studentID);
    if (result == FINGERPRINT_OK) {
      sendOutput("Enrollment successful from NFC tag. Student " + String(studentID) + " saved to slot " + String(slot) + ".", -1);
    } else {
      sendOutput("Enrollment failed for NFC student " + String(studentID) + ".", -1);
    }
    return;
  }

  // Scanner mode: expect encrypted payload
  String parts[4];
  int partIndex = 0, start = 0;
  for (int i = 0; i <= (int)tagText.length() && partIndex < 4; i++) {
    if (i == (int)tagText.length() || tagText[i] == '|') {
      parts[partIndex++] = tagText.substring(start, i);
      start = i + 1;
    }
  }
  if (partIndex < 4 || parts[0].length() == 0) return;

  String encryptedData = parts[0];
  String iv            = parts[1];
  String authTag       = parts[2];
  String date          = parts[3];

  Serial.printf("[NFC] Got encrypted payload for date %s\n", date.c_str());
  writeNFCText(" ");

  String dateStr, timeStr;
  getDateTime(dateStr, timeStr);

  if (WiFi.status() != WL_CONNECTED || authToken == "") {
    queueOfflineNFCLog(encryptedData, iv, authTag, date, dateStr, timeStr);
    setLedSuccess();
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, String(serverEndpoint) + "/api/scanner/log")) {
    http.end(); return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + authToken);

  StaticJsonDocument<512> doc;
  doc["encryptedData"]    = encryptedData;
  doc["iv"]               = iv;
  doc["authTag"]          = authTag;
  doc["date"]             = date;
  doc["scanner_location"] = config.scanner_loc;
  doc["scanner_id"]       = config.scanner_id;
  doc["date_scanned"]     = dateStr;
  doc["time_scanned"]     = timeStr;
  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  if (code == 201) {
    Serial.println("[NFC] Log created successfully");
    setLedSuccess();
    sendOutput("NFC scan logged.", -1);
  } else {
    Serial.printf("[NFC] Server returned %d\n", code);
    queueOfflineNFCLog(encryptedData, iv, authTag, date, dateStr, timeStr);
  }
  http.end();
}

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  EEPROM.begin(EEPROM_SIZE);
  loadConfig();

  WiFi.mode(WIFI_STA);
  delay(1000);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Serial.println("\n========== BLUEPRINT SCANNER STARTUP ==========");
  Serial.println("[INIT] Initializing fingerprint sensor...");
  initializeFingerprint();

  Serial.println("[INIT] Initializing NFC scanner...");
  initializeNFC();

  if (!LittleFS.begin(true)) {
    Serial.println("[ERROR] LittleFS mount failed!");
    while (1) delay(1);
  }
  loadStudents();

  Serial.println("[INIT] Connecting to WiFi...");
  connectWifi();

  Serial.println("[INIT] Syncing time with NTP (non-blocking)...");
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi connection failed — will retry in loop.");
  }

  Serial.println("\n========== SCANNER READY ==========");
  Serial.println("Hold button 5 seconds to enable Bluetooth configuration.");
  Serial.println("WiFi SSID: "   + String(config.ssid));
  Serial.println("Scanner ID: "  + String(config.scanner_id));
  Serial.println("=====================================\n");
}

// ========== LOOP ==========
void loop() {
  webSocket.loop();

  if (pendingRestart) {
    pendingRestart = false;
    Serial.println("[SYSTEM] Restarting after BLE config update...");
    if (bleModeActive) {
      stopBLE();
      delay(200);
    }
    delay(100);
    ESP.restart();
  }

  // ── WiFi state management ──
  static unsigned long lastWifiRetry  = 0;
  static bool          wifiJustConnected = false;

  if (WiFi.status() == WL_CONNECTED && !WifiConnected) {
    WifiConnected      = true;
    wifiJustConnected  = true;
    Serial.println("[WIFI] Connected. IP: " + WiFi.localIP().toString());
  } else if (WiFi.status() != WL_CONNECTED && WifiConnected) {
    WifiConnected = false;
    Serial.println("[WIFI] Lost connection.");
  } else if (WiFi.status() != WL_CONNECTED && !WifiConnected) {
    if (millis() - lastWifiRetry > 300000) {
      lastWifiRetry = millis();
      Serial.println("[WIFI] Attempting reconnect...");
      connectWifi();
    }
  }

  if (wifiJustConnected) {
    wifiJustConnected = false;
    if (signIn()) flushOfflineLogs();
    webSocket.beginSSL(wsHost, wsPort, wsPath);
    webSocket.onEvent(onWebSocketEvent);
    webSocket.setReconnectInterval(5000);
  }

  // ===== BLE MODE HANDLING =====
  if (bleModeActive) {

    // Stay in BLE mode while connected
    if (bleDeviceConnected) {
      delay(10);
      return;
    }

    // If disconnected for 5 seconds, shut BLE down
    if (!bleDeviceConnected &&
    millis() - bleModeStartTime > BLE_MIN_RUNTIME &&
    millis() - bleDisconnectTime > 10000) {

      Serial.println("[BLE] Returning to WiFi mode...");

      stopBLE();

      delay(500);

      WiFi.mode(WIFI_STA);

      connectWifi();
    }

    delay(10);
    return;
  }

  // ── Auto re-auth if token lost ──
  static unsigned long lastReauthAttempt = 0;
  if (WifiConnected && authToken == "" && (millis() - lastReauthAttempt > 15000)) {
    lastReauthAttempt = millis();
    Serial.println("[AUTH] Token missing — attempting automatic re-auth...");
    if (signIn()) {
      flushOfflineLogs();
      if (webSocket.isConnected()) {
        StaticJsonDocument<256> doc;
        doc["type"]      = "auth";
        doc["scannerId"] = scannerDbId;
        doc["token"]     = authToken;
        String msg;
        serializeJson(doc, msg);
        webSocket.sendTXT(msg);
      }
    }
  }

  // ── LED ──
  updateLedStatus();

  // ── NFC (windowed: 500ms active, 2000ms rest) ──
  if (mode == "scanner" || mode == "enroll") {
    static unsigned long nfcWindowStart  = 0;
    static bool          nfcActive       = true;
    static bool          nfcNeedsReinit  = false;

    if (nfcActive) {
      handleNFCCardNonBlocking();
      if (millis() - nfcWindowStart >= 500) {
        nfcActive      = false;
        nfcNeedsReinit = true;
        nfcWindowStart = millis();
      }
    } else {
      if (nfcNeedsReinit && millis() - nfcWindowStart >= 100) {
        Wire.end();
        Wire.begin(21, 22);
        nfc.begin();
        nfc.SAMConfig();
        nfcNeedsReinit = false;
      }
      if (millis() - nfcWindowStart >= 2000) {
        nfcActive      = true;
        nfcWindowStart = millis();
      }
    }
  }

  // ── Fingerprint scan ──
  if (fingerprintInitialized && (mode == "scanner" || mode == "enroll")) {
    int fingerID = scanFingerprint();
    if (fingerID >= 0) {
      int studentID = findStudent(fingerID);
      if (studentID > 0) {
        static unsigned long lastScanTime = 0;
        if (millis() - lastScanTime < 3000) return;
        lastScanTime = millis();
        setLedSuccess();
        if (mode == "scanner") {
          pendingLog.studentID = studentID;
          strncpy(pendingLog.method, "fingerprint", sizeof(pendingLog.method) - 1);
          pendingLog.pending = true;
          sendOutput("Fingerprint Match - Logged attendance for Student " + String(studentID), -1);
        }
      }
    }
  }

  // ── Process pending log ──
  if (pendingLog.pending) {
    pendingLog.pending = false;
    sendLog(pendingLog.studentID, String(pendingLog.method));
  }

  // ── Button ──
  handleButton();

  // ── Heartbeat ──
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat > 5000) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  delay(10);
}
