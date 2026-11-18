package kr.cheatingguard.app

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * 칫팅가드 Android 앱
 * - 저장소의 웹 앱 화면(assets/www)을 WebView로 그대로 보여 준다 (인터넷 연결 불필요, 외부 전송 없음)
 * - 웹 앱이 할 수 없는 기능(주변 Wi-Fi·블루투스 전체·클래식 스캔, 자기장 센서)을 NativeBridge로 제공한다
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var bridge: NativeBridge
    private var pendingWebPermission: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // 서비스 워커 요청도 앱 안의 파일로 응답
        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
                override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)
            })
        } catch (_: Throwable) { }

        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            // 앱 밖 주소(출처 링크 등)는 열지 않는다
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != "appassets.androidplatform.net"
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    if (!wantsCamera) { request.deny(); return@runOnUiThread }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingWebPermission = request
                        requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
                    }
                }
            }
        }

        bridge = NativeBridge(this, web)
        web.addJavascriptInterface(bridge, "CGNative")
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA) {
            val req = pendingWebPermission
            pendingWebPermission = null
            if (req != null) {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else req.deny()
            }
        } else if (requestCode == NativeBridge.REQ_SCAN) {
            bridge.onPermissionResult(permissions, grantResults)
        }
    }

    override fun onPause() {
        super.onPause()
        bridge.stopAll()
        web.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onDestroy() {
        bridge.stopAll()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val REQ_CAMERA = 101
    }
}
