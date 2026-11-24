import com.facebook.react.bridge.ReactContext;
import com.shopify.reactnative.skia.PlatformContext;
import java.io.*;
import java.net.*;
import java.lang.reflect.Field;
import sun.misc.Unsafe;

public class SkiaAndroidLoaderTest {
  static class TrackedStream extends ByteArrayInputStream {
    boolean closed;
    boolean fail;
    TrackedStream(byte[] bytes) { super(bytes); }
    @Override public synchronized int read(byte[] data, int off, int len) {
      if (fail) throw new UncheckedIOException(new IOException("read failure"));
      return super.read(data, off, len);
    }
    @Override public void close() throws IOException { closed = true; super.close(); }
  }
  static class Connection extends HttpURLConnection {
    final TrackedStream stream;
    int opens;
    boolean disconnected;
    boolean failOpen;
    Connection(URL url, TrackedStream stream) { super(url); this.stream = stream; }
    @Override public InputStream getInputStream() throws IOException {
      opens++;
      assert getConnectTimeout() == 15000;
      assert getReadTimeout() == 15000;
      if (failOpen) throw new SocketTimeoutException("connect timeout");
      return stream;
    }
    @Override public void disconnect() { disconnected = true; }
    @Override public boolean usingProxy() { return false; }
    @Override public void connect() {}
  }
  static Connection connection;
  static TrackedStream stream;
  static boolean failOpen;
  static void expectFailure(PlatformContext loader, String uri) throws Exception {
    try { loader.getJniStreamFromSource(uri); throw new AssertionError("Expected failure: " + uri); }
    catch (IOException expected) {}
  }
  public static void main(String[] args) throws Exception {
    URL.setURLStreamHandlerFactory(protocol -> protocol.equals("tracked") ? new URLStreamHandler() {
      @Override protected URLConnection openConnection(URL url) {
        connection = new Connection(url, stream);
        connection.failOpen = failOpen;
        return connection;
      }
    } : null);
    // Skip only Android's native constructor. The production loader itself is
    // compiled unchanged, with instrumented Android resources and URL streams.
    Field unsafeField = Unsafe.class.getDeclaredField("theUnsafe"); unsafeField.setAccessible(true);
    Unsafe unsafe = (Unsafe) unsafeField.get(null);
    PlatformContext loader = (PlatformContext) unsafe.allocateInstance(PlatformContext.class);
    ReactContext context = new ReactContext();
    Field contextField = PlatformContext.class.getDeclaredField("mContext"); contextField.setAccessible(true);
    contextField.set(loader, context);

    byte[] expected = { 1, 2, 3 };
    stream = new TrackedStream(expected);
    assert java.util.Arrays.equals(loader.getJniStreamFromSource("tracked://success"), expected);
    assert stream.closed && connection.disconnected && connection.opens == 1;

    stream = new TrackedStream(new byte[0]);
    expectFailure(loader, "tracked://empty");
    assert stream.closed && connection.disconnected;

    stream = new TrackedStream(expected); stream.fail = true;
    expectFailure(loader, "tracked://read-failure");
    assert stream.closed && connection.disconnected;

    failOpen = true;
    expectFailure(loader, "tracked://timeout");
    assert connection.disconnected && connection.opens == 1;
    failOpen = false;

    expectFailure(loader, "::bad uri");
    expectFailure(loader, "missing-scheme");

    stream = new TrackedStream(expected); context.resources.stream = stream;
    assert java.util.Arrays.equals(loader.getJniStreamFromSource("raw"), expected);
    assert stream.closed;
    stream = new TrackedStream(new byte[0]); context.resources.stream = stream;
    expectFailure(loader, "raw"); assert stream.closed;
    System.out.println("Skia Android loader: success/empty/read error/timeout/malformed URI/raw resources/close/disconnect/single connection PASS");
  }
}
