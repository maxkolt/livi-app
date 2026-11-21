import { Schema, model, models } from 'mongoose';

const schema = new Schema({
  filename: { type: String, required: true, unique: true },
  owner: { type: Schema.Types.ObjectId, required: true, index: true },
}, { timestamps: true, collection: 'media_uploads' });

export default models.MediaUpload || model('MediaUpload', schema);
