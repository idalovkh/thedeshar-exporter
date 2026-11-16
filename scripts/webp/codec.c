#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <webp/decode.h>
#include <webp/encode.h>

enum { HD_LONG_SIDE = 1920, HD_SHORT_SIDE = 1080, MAX_MEDIA_BYTES = 100 << 20 };

typedef struct {
  int width, height;
} Image;

typedef struct {
  uint8_t* data;
  size_t size, capacity, limit;
} WebpOutput;

static uint8_t* result;

static uint32_t rgba_to_argb(const uint8_t* rgba) {
  return ((uint32_t)rgba[3] << 24) | ((uint32_t)rgba[0] << 16) |
         ((uint32_t)rgba[1] << 8) | rgba[2];
}

static int write_webp(const uint8_t* data, size_t size, const WebPPicture* picture) {
  WebpOutput* out = picture->custom_ptr;
  if (size > out->limit - out->size) return 0;
  if (size == 0) return 1;
  size_t need = out->size + size;
  if (need > out->capacity) {
    size_t capacity = out->capacity ? out->capacity * 2 : 64 << 10;
    if (capacity < need) capacity = need;
    if (capacity > out->limit) capacity = out->limit;
    uint8_t* grown = realloc(out->data, capacity);
    if (!grown) return 0;
    out->data = grown;
    out->capacity = capacity;
  }
  memcpy(out->data + out->size, data, size);
  out->size = need;
  return 1;
}

static int verify_webp(const WebpOutput* out, const Image* image, const uint32_t* pixels) {
  WebPBitstreamFeatures features;
  if (WebPGetFeatures(out->data, out->size, &features) != VP8_STATUS_OK ||
      features.format != 2 || features.has_animation || features.width != image->width ||
      features.height != image->height) return 0;
  const size_t count = (size_t)image->width * image->height;
  uint8_t* decoded = malloc(count * 4);
  if (!decoded) return 0;
  int same = WebPDecodeRGBAInto(out->data, out->size, decoded, count * 4, image->width * 4) != NULL;
  for (size_t i = 0; same && i < count; ++i) {
    same = rgba_to_argb(decoded + i * 4) == pixels[i];
  }
  free(decoded);
  return same;
}

void release_encoded_webp(void) {
  free(result);
  result = NULL;
}

const uint8_t* encoded_webp_result(void) { return result; }

static size_t encode_argb(const Image* image, uint32_t* pixels, size_t output_limit) {
  WebpOutput output = { .limit = output_limit };
  WebPConfig config;
  WebPPicture picture;
  if (WebPConfigInit(&config) && WebPConfigLosslessPreset(&config, 0) && WebPPictureInit(&picture)) {
    config.exact = 1;
    config.thread_level = 0;
    picture.use_argb = 1;
    picture.width = image->width;
    picture.height = image->height;
    picture.argb = pixels;
    picture.argb_stride = image->width;
    picture.writer = write_webp;
    picture.custom_ptr = &output;
    if (WebPEncode(&config, &picture) && verify_webp(&output, image, pixels)) {
      result = output.data;
    }
    WebPPictureFree(&picture);
  }
  if (result) return output.size;
  free(output.data);
  return 0;
}

size_t encode_verified_rgba(const uint8_t* data, size_t size, int width, int height) {
  release_encoded_webp();
  if (width < 1 || height < 1 || width > HD_LONG_SIDE || height > HD_LONG_SIDE ||
      (width > HD_SHORT_SIDE && height > HD_SHORT_SIDE)) return 0;
  const size_t count = (size_t)width * height;
  if (size != count * 4) return 0;
  uint32_t* pixels = malloc(count * sizeof(*pixels));
  if (!pixels) return 0;
  for (size_t i = 0; i < count; ++i) pixels[i] = rgba_to_argb(data + i * 4);
  const Image image = { .width = width, .height = height };
  const size_t encoded = encode_argb(&image, pixels, MAX_MEDIA_BYTES);
  free(pixels);
  return encoded;
}
