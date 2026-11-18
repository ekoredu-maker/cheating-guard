package kr.cheatingguard.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 웹 화면(JavaScript)에서 window.CGNative 로 호출하는 기능.
 * 결과는 window.CGNativeEvent(종류, 데이터) 로 전달한다.
 * 개인정보 보호: 기기 MAC 주소는 앱 실행마다 바뀌는 무작위 값으로 해시해 전달하고, 저장하지 않는다.
 * Wi-Fi는 제조사 구분용 앞 3바이트(OUI)만 함께 전달한다.
 */
class NativeBridge(private val act: Activity, private val web: WebView) {

    private val main = Handler(Looper.getMainLooper())
    private val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }

    private val btManager = act.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?
    private val btAdapter: BluetoothAdapter? get() = btManager?.adapter
    private val wifi = act.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager?
    private val sensorManager = act.getSystemService(Context.SENSOR_SERVICE) as SensorManager?

    // ---------------------------------------------------------------- 공통
    private fun emit(type: String, payload: String) {
        main.post {
            web.evaluateJavascript("window.CGNativeEvent&&window.CGNativeEvent(${JSONObject.quote(type)},$payload)", null)
        }
    }

    private fun anonId(addr: String?): String {
        if (addr == null) return "x"
        val md = MessageDigest.getInstance("SHA-256")
        md.update(salt)
        md.update(addr.toByteArray())
        return md.digest().take(6).joinToString("") { "%02x".format(it) }
    }

    private fun hex(b: ByteArray?, max: Int = 31): String =
        b?.take(max)?.joinToString("") { "%02X".format(it) } ?: ""

    private fun has(p: String) = act.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun scanPermissions(): List<String> {
        val l = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) { l += Manifest.permission.BLUETOOTH_SCAN; l += Manifest.permission.BLUETOOTH_CONNECT }
        if (Build.VERSION.SDK_INT >= 33) l += Manifest.permission.NEARBY_WIFI_DEVICES
        return l
    }

    private fun bleAllowed(): Boolean =
        if (Build.VERSION.SDK_INT >= 31) has(Manifest.permission.BLUETOOTH_SCAN) && has(Manifest.permission.BLUETOOTH_CONNECT)
        else has(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun wifiAllowed(): Boolean = has(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun locationOn(): Boolean {
        val lm = act.getSystemService(Context.LOCATION_SERVICE) as LocationManager? ?: return false
        return if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled
        else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    @JavascriptInterface
    fun info(): String {
        val o = JSONObject()
        o.put("app", "android")
        o.put("version", "1.6.0")
        o.put("sdk", Build.VERSION.SDK_INT)
        o.put("ble", btAdapter != null && act.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE))
        o.put("classic", btAdapter != null)
        o.put("btOn", btAdapter?.isEnabled == true)
        o.put("wifi", wifi != null)
        o.put("wifiOn", wifi?.isWifiEnabled == true)
        o.put("magnetometer", sensorManager?.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) != null)
        o.put("locationOn", locationOn())
        o.put("bleAllowed", bleAllowed())
        o.put("wifiAllowed", wifiAllowed())
        return o.toString()
    }

    @JavascriptInterface
    fun requestPermissions() {
        main.post {
            val need = scanPermissions().filter { !has(it) }
            if (need.isEmpty()) emit("perm", info())
            else act.requestPermissions(need.toTypedArray(), REQ_SCAN)
        }
    }

    fun onPermissionResult(@Suppress("UNUSED_PARAMETER") permissions: Array<out String>, @Suppress("UNUSED_PARAMETER") results: IntArray) {
        emit("perm", info())
    }

    @JavascriptInterface
    fun openLocationSettings() {
        main.post { try { act.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) } catch (_: Throwable) { } }
    }

    @JavascriptInterface
    fun openBluetoothSettings() {
        main.post { try { act.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) } catch (_: Throwable) { } }
    }

    @JavascriptInterface
    fun vibrate(ms: Int) {
        try {
            @Suppress("DEPRECATION")
            val v = act.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator?
            v?.vibrate(VibrationEffect.createOneShot(ms.toLong().coerceIn(10, 2000), VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (_: Throwable) { }
    }

    // ---------------------------------------------------------------- BLE 전체 스캔
    private val bleBatch = LinkedHashMap<String, JSONObject>()
    private var bleScanning = false
    private val bleFlush = object : Runnable {
        override fun run() {
            if (!bleScanning) return
            val arr = JSONArray()
            synchronized(bleBatch) { bleBatch.values.forEach { arr.put(it) }; bleBatch.clear() }
            if (arr.length() > 0) emit("ble", arr.toString())
            main.postDelayed(this, 500)
        }
    }

    private val bleCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val o = JSONObject()
            o.put("id", anonId(result.device?.address))
            o.put("rssi", result.rssi)
            if (result.txPower != ScanResult.TX_POWER_NOT_PRESENT) o.put("txPower", result.txPower)
            o.put("connectable", result.isConnectable)
            val rec = result.scanRecord
            var name: String? = rec?.deviceName
            if (name == null) name = try { result.device?.name } catch (_: SecurityException) { null }
            if (name != null) o.put("name", name)
            val mfr = JSONObject()
            val sa = rec?.manufacturerSpecificData
            if (sa != null) for (i in 0 until sa.size()) mfr.put(sa.keyAt(i).toString(), hex(sa.valueAt(i)))
            o.put("mfr", mfr)
            val uu = JSONArray()
            rec?.serviceUuids?.forEach { uu.put(it.uuid.toString()) }
            o.put("uuids", uu)
            val sd = JSONObject()
            rec?.serviceData?.forEach { (k, v) -> sd.put(k.uuid.toString(), hex(v)) }
            o.put("serviceData", sd)
            o.put("t", System.currentTimeMillis())
            synchronized(bleBatch) { bleBatch[o.getString("id")] = o }
        }

        override fun onScanFailed(errorCode: Int) {
            bleScanning = false
            emit("bleError", JSONObject().put("code", errorCode).toString())
        }
    }

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    fun startBle(): String {
        val a = btAdapter ?: return err("no-bluetooth")
        if (!bleAllowed()) return err("permission")
        if (!a.isEnabled) return err("bluetooth-off")
        val scanner = a.bluetoothLeScanner ?: return err("no-scanner")
        if (bleScanning) return ok()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        return try {
            scanner.startScan(null, settings, bleCallback)
            bleScanning = true
            main.postDelayed(bleFlush, 500)
            ok()
        } catch (e: SecurityException) { err("permission") } catch (e: Throwable) { err("start-failed") }
    }

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    fun stopBle() {
        if (!bleScanning) return
        bleScanning = false
        try { btAdapter?.bluetoothLeScanner?.stopScan(bleCallback) } catch (_: Throwable) { }
    }

    // ---------------------------------------------------------------- 블루투스 클래식(이어폰·헤드셋 등) 검색
    private var classicReceiver: BroadcastReceiver? = null

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    fun startClassic(): String {
        val a = btAdapter ?: return err("no-bluetooth")
        if (!bleAllowed()) return err("permission")
        if (!a.isEnabled) return err("bluetooth-off")
        stopClassicInternal()
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                when (intent.action) {
                    BluetoothDevice.ACTION_FOUND -> {
                        val dev: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33)
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                        else @Suppress("DEPRECATION") intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                        val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt()
                        val o = JSONObject()
                        o.put("id", anonId(dev?.address))
                        if (rssi != Short.MIN_VALUE.toInt()) o.put("rssi", rssi)
                        try { dev?.name?.let { o.put("name", it) } } catch (_: SecurityException) { }
                        try {
                            val cls: BluetoothClass? = dev?.bluetoothClass
                            if (cls != null) { o.put("major", cls.majorDeviceClass); o.put("device", cls.deviceClass) }
                        } catch (_: SecurityException) { }
                        try { o.put("type", dev?.type ?: 0) } catch (_: SecurityException) { }
                        o.put("t", System.currentTimeMillis())
                        emit("classic", o.toString())
                    }
                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> emit("classicDone", "{}")
                }
            }
        }
        val f = IntentFilter().apply { addAction(BluetoothDevice.ACTION_FOUND); addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED) }
        if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(r, f, Context.RECEIVER_EXPORTED) else act.registerReceiver(r, f)
        classicReceiver = r
        return try {
            if (a.isDiscovering) a.cancelDiscovery()
            if (a.startDiscovery()) ok() else err("start-failed")
        } catch (e: SecurityException) { err("permission") }
    }

    @SuppressLint("MissingPermission")
    private fun stopClassicInternal() {
        try { if (btAdapter?.isDiscovering == true) btAdapter?.cancelDiscovery() } catch (_: Throwable) { }
        classicReceiver?.let { try { act.unregisterReceiver(it) } catch (_: Throwable) { } }
        classicReceiver = null
    }

    @JavascriptInterface
    fun stopClassic() { main.post { stopClassicInternal() } }

    // ---------------------------------------------------------------- Wi-Fi 주변 스캔
    private var wifiReceiver: BroadcastReceiver? = null

    @SuppressLint("MissingPermission")
    private fun emitWifiResults(fresh: Boolean) {
        val w = wifi ?: return
        val list = try { w.scanResults } catch (e: SecurityException) { emit("wifiError", JSONObject().put("error", "permission").toString()); return }
        val arr = JSONArray()
        for (r in list) {
            val o = JSONObject()
            @Suppress("DEPRECATION") val ssid = r.SSID ?: ""
            o.put("ssid", ssid)
            o.put("id", anonId(r.BSSID))
            o.put("oui", (r.BSSID ?: "").take(8).uppercase())
            o.put("rssi", r.level)
            o.put("freq", r.frequency)
            o.put("security", r.capabilities ?: "")
            o.put("ageMs", (android.os.SystemClock.elapsedRealtime() - r.timestamp / 1000).coerceAtLeast(0))
            arr.put(o)
        }
        emit("wifi", JSONObject().put("fresh", fresh).put("t", System.currentTimeMillis()).put("list", arr).toString())
    }

    @JavascriptInterface
    fun scanWifi(): String {
        val w = wifi ?: return err("no-wifi")
        if (!wifiAllowed()) return err("permission")
        if (!w.isWifiEnabled) return err("wifi-off")
        main.post {
            if (wifiReceiver == null) {
                val r = object : BroadcastReceiver() {
                    override fun onReceive(c: Context, intent: Intent) {
                        val updated = intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false)
                        emitWifiResults(updated)
                    }
                }
                val f = IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
                if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(r, f, Context.RECEIVER_EXPORTED) else act.registerReceiver(r, f)
                wifiReceiver = r
            }
            emitWifiResults(false)
            @Suppress("DEPRECATION")
            val started = try { w.startScan() } catch (_: Throwable) { false }
            if (!started) emit("wifiThrottled", "{}")
        }
        return ok()
    }

    private fun stopWifiInternal() {
        wifiReceiver?.let { try { act.unregisterReceiver(it) } catch (_: Throwable) { } }
        wifiReceiver = null
    }

    // ---------------------------------------------------------------- 자기장 센서 (µT)
    private var magLast = 0L
    private val magListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val now = System.currentTimeMillis()
            if (now - magLast < 80) return
            magLast = now
            emit("mag", JSONObject().put("x", e.values[0].toDouble()).put("y", e.values[1].toDouble()).put("z", e.values[2].toDouble()).put("acc", e.accuracy).toString())
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) { }
    }
    private var magOn = false

    @JavascriptInterface
    fun startMag(): String {
        val sm = sensorManager ?: return err("no-sensor")
        val s = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) ?: return err("no-sensor")
        if (!magOn) { sm.registerListener(magListener, s, SensorManager.SENSOR_DELAY_GAME); magOn = true }
        return ok()
    }

    @JavascriptInterface
    fun stopMag() {
        if (magOn) { sensorManager?.unregisterListener(magListener); magOn = false }
    }

    // ---------------------------------------------------------------- 정리
    fun stopAll() {
        stopBle()
        stopClassicInternal()
        stopWifiInternal()
        stopMag()
    }

    private fun ok() = "{\"ok\":true}"
    private fun err(code: String) = JSONObject().put("ok", false).put("error", code).toString()

    companion object {
        const val REQ_SCAN = 202
    }
}
